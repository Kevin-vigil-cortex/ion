import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import type { AttachmentKind, MessageAttachment } from '@ion/agent'
import { resolveUserPath } from '@ion/agent'
import { ATTACHMENTS_DIR } from './paths'

const execFileAsync = promisify(execFile)

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_FILE_BYTES = 48 * 1024 * 1024
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024
export const MAX_ATTACHMENTS = 12

export interface IncomingAttachment {
  name: string
  mimeType: string
  path?: string
  data?: ArrayBuffer
  silent?: boolean
  /** Renderer already sampled frames — don't run ffmpeg. */
  skipFrames?: boolean
}

const IMAGE_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.heic',
  '.heif',
  '.tif',
  '.tiff'
])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v', '.mkv', '.avi'])

export function classifyAttachment(mimeType: string, name: string): AttachmentKind {
  const mime = mimeType.toLowerCase()
  const ext = extname(name).toLowerCase()
  if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image'
  if (mime.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video'
  return 'file'
}

export function guessMime(name: string, fallback = 'application/octet-stream'): string {
  const ext = extname(name).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.m4v': 'video/mp4',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json'
  }
  return map[ext] ?? fallback
}

function sanitizeName(name: string): string {
  const base = basename(name).replace(/[^\w.\- ()[\]]+/g, '_')
  return base.slice(0, 120) || 'file'
}

function sessionDir(sessionId: string): string {
  return join(ATTACHMENTS_DIR, sessionId)
}

export async function ingestAttachments(
  sessionId: string,
  files: IncomingAttachment[]
): Promise<MessageAttachment[]> {
  if (files.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS}).`)
  }
  const dir = sessionDir(sessionId)
  await fs.mkdir(dir, { recursive: true })
  const out: MessageAttachment[] = []

  for (const f of files) {
    const id = randomUUID()
    const safe = sanitizeName(f.name)
    let dest = join(dir, `${id}-${safe}`)
    if (f.path) {
      await fs.copyFile(f.path, dest)
    } else if (f.data) {
      await fs.writeFile(dest, Buffer.from(f.data))
    } else {
      throw new Error(`Attachment ${f.name} has no path or data.`)
    }

    let mime = f.mimeType || guessMime(f.name)
    let kind = classifyAttachment(mime, f.name)
    const stat = await fs.stat(dest)
    const max =
      kind === 'image' ? MAX_IMAGE_BYTES : kind === 'video' ? MAX_VIDEO_BYTES : MAX_FILE_BYTES
    if (stat.size > max) {
      await fs.rm(dest, { force: true })
      throw new Error(`${f.name} is too large (max ${Math.round(max / 1024 / 1024)}MB).`)
    }

    if (kind === 'image' && /\.hei[cf]$/i.test(f.name)) {
      const jpeg = dest.replace(/\.[^.]+$/, '') + '.jpg'
      try {
        await execFileAsync('sips', ['-s', 'format', 'jpeg', dest, '--out', jpeg])
        dest = jpeg
        mime = 'image/jpeg'
      } catch {
        // Keep HEIC; Chromium/xAI may still reject it.
      }
    }

    out.push({
      id,
      name: f.name,
      mimeType: mime,
      kind,
      path: dest,
      ...(f.silent ? { silent: true } : {})
    })

    if (kind === 'video' && !f.silent && !f.skipFrames) {
      const frames = await extractVideoFrames(dest, dir, id, f.name)
      out.push(...frames)
    }
  }

  return out
}

async function extractVideoFrames(
  videoPath: string,
  dir: string,
  videoId: string,
  videoName: string
): Promise<MessageAttachment[]> {
  const ffmpeg = whichOnPath('ffmpeg')
  const ffprobe = whichOnPath('ffprobe')
  if (!ffmpeg) return []

  let duration = 0
  if (ffprobe) {
    try {
      const { stdout } = await execFileAsync(ffprobe, [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        videoPath
      ])
      duration = Number(stdout.trim())
    } catch {
      duration = 0
    }
  }

  const stamps =
    Number.isFinite(duration) && duration > 1
      ? [0.05, 0.2, 0.4, 0.6, 0.8, 0.95].map((p) => duration * p)
      : [0]
  const frames: MessageAttachment[] = []
  for (let i = 0; i < stamps.length; i++) {
    const dest = join(dir, `${videoId}-f${String(i + 1).padStart(2, '0')}.jpg`)
    try {
      await execFileAsync(ffmpeg, [
        '-y',
        '-ss',
        String(stamps[i]),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        dest
      ])
      frames.push({
        id: randomUUID(),
        name: `${videoName} · frame ${i + 1}`,
        mimeType: 'image/jpeg',
        kind: 'image',
        path: dest,
        silent: true
      })
    } catch {
      // Skip a failed seek; others may still work.
    }
  }
  return frames
}

function whichOnPath(bin: string): string | null {
  const dirs = resolveUserPath().split(':')
  for (const dir of dirs) {
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export async function attachmentPreview(path: string): Promise<string | null> {
  let resolved: string
  let root: string
  try {
    resolved = await fs.realpath(path)
    root = await fs.realpath(ATTACHMENTS_DIR)
  } catch {
    return null
  }
  if (resolved !== root && !resolved.startsWith(root + '/')) return null
  return readImageDataUrl(resolved)
}

/** Preview for a file the user just dropped/picked (not yet copied into ~/.ion). */
export async function localImagePreview(path: string): Promise<string | null> {
  try {
    return await readImageDataUrl(await fs.realpath(path))
  } catch {
    return null
  }
}

async function readImageDataUrl(resolved: string): Promise<string | null> {
  const kind = classifyAttachment(guessMime(resolved), resolved)
  if (kind !== 'image') return null
  const buf = await fs.readFile(resolved)
  if (buf.length > MAX_IMAGE_BYTES) return null
  return `data:${guessMime(resolved, 'image/png')};base64,${buf.toString('base64')}`
}

export async function deleteSessionAttachments(sessionId: string): Promise<void> {
  await fs.rm(sessionDir(sessionId), { recursive: true, force: true })
}
