import type { ChatAttachmentPayload } from '../../shared/ipc'

export type AttachmentKind = 'image' | 'file' | 'video'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_FILE_BYTES = 48 * 1024 * 1024
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024
export const MAX_ATTACHMENTS = 12

export interface DraftAttachment {
  id: string
  name: string
  mimeType: string
  kind: AttachmentKind
  previewUrl?: string
  path?: string
  data?: ArrayBuffer
  silent?: boolean
  skipFrames?: boolean
  frames?: { name: string; mimeType: string; data: ArrayBuffer }[]
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|hei[cf]|tiff?)$/i
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv|avi)$/i

export function classifyAttachment(mimeType: string, name: string): AttachmentKind {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('image/') || IMAGE_EXT.test(name)) return 'image'
  if (mime.startsWith('video/') || VIDEO_EXT.test(name)) return 'video'
  return 'file'
}

export function maxBytesFor(kind: AttachmentKind): number {
  if (kind === 'image') return MAX_IMAGE_BYTES
  if (kind === 'video') return MAX_VIDEO_BYTES
  return MAX_FILE_BYTES
}

export function filesFromDataTransfer(dt: DataTransfer): File[] {
  const out: File[] = []
  if (dt.files?.length) {
    for (const f of Array.from(dt.files)) {
      if (f.size === 0 && !f.type) continue
      out.push(f)
    }
    return out
  }
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f && !(f.size === 0 && !f.type)) out.push(f)
    }
  }
  return out
}

export async function fileToDraft(file: File, id: string): Promise<DraftAttachment> {
  const path = window.ion.pathForDroppedFile(file) || undefined
  const kind = classifyAttachment(file.type, file.name)
  const draft: DraftAttachment = {
    id,
    name: file.name || (kind === 'image' ? 'image.png' : 'file'),
    mimeType: file.type || '',
    kind,
    path
  }
  if (kind === 'image') {
    draft.previewUrl = await imagePreviewUrl(file, path)
  }
  if (!path) {
    draft.data = await file.arrayBuffer()
  }
  if (kind === 'video') {
    try {
      const frames = await extractVideoFrames(file)
      draft.frames = frames
      draft.skipFrames = frames.length > 0
      if (frames[0]) {
        draft.previewUrl = bufferToDataUrl(frames[0].data, 'image/jpeg')
      }
    } catch {
      // ffmpeg on the main side is the fallback
    }
  }
  return draft
}

export function draftsToPayloads(drafts: DraftAttachment[]): ChatAttachmentPayload[] {
  const out: ChatAttachmentPayload[] = []
  for (const d of drafts) {
    out.push({
      name: d.name,
      mimeType: d.mimeType,
      ...(d.path ? { path: d.path } : {}),
      ...(d.data && !d.path ? { data: d.data } : {}),
      ...(d.silent ? { silent: true } : {}),
      ...(d.skipFrames ? { skipFrames: true } : {})
    })
    for (const frame of d.frames ?? []) {
      out.push({
        name: frame.name,
        mimeType: frame.mimeType,
        data: frame.data,
        silent: true
      })
    }
  }
  return out
}

export function revokeDraft(draft: DraftAttachment): void {
  if (draft.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(draft.previewUrl)
}

/** data: URLs pass CSP; blob: from a raw Finder File often renders as a broken icon. */
async function imagePreviewUrl(file: File, path?: string): Promise<string | undefined> {
  try {
    return await readAsDataUrl(file)
  } catch {
    if (path) return (await window.ion.localImagePreview(path)) ?? undefined
    return undefined
  }
}

function bufferToDataUrl(buf: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(bin)}`
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string' && result.startsWith('data:')) resolve(result)
      else reject(new Error('empty preview'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** A video that never loads/seeks must fail (→ ffmpeg fallback), not hang. */
const VIDEO_LOAD_TIMEOUT_MS = 10_000
const VIDEO_SEEK_TIMEOUT_MS = 5_000

async function extractVideoFrames(
  file: File,
  count = 6
): Promise<{ name: string; mimeType: string; data: ArrayBuffer }[]> {
  const url = URL.createObjectURL(file)
  try {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.src = url
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('Video decode timed out')),
        VIDEO_LOAD_TIMEOUT_MS
      )
      video.onloadeddata = () => {
        window.clearTimeout(timer)
        resolve()
      }
      video.onerror = () => {
        window.clearTimeout(timer)
        reject(new Error('Could not decode video'))
      }
    })
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const srcW = video.videoWidth || 1280
    const srcH = video.videoHeight || 720
    const w = Math.min(srcW, 1280)
    const h = Math.max(1, Math.round(srcH * (w / srcW)))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return []

    const n = duration > 1 ? count : 1
    const frames: { name: string; mimeType: string; data: ArrayBuffer }[] = []
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : (duration * i) / (n - 1)
      video.currentTime = Math.min(Math.max(t, 0), Math.max(duration - 0.05, 0))
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error('Video seek timed out')),
          VIDEO_SEEK_TIMEOUT_MS
        )
        video.onseeked = () => {
          window.clearTimeout(timer)
          resolve()
        }
      })
      ctx.drawImage(video, 0, 0, w, h)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.85)
      )
      if (!blob) continue
      frames.push({
        name: `${file.name} · frame ${i + 1}`,
        mimeType: 'image/jpeg',
        data: await blob.arrayBuffer()
      })
    }
    return frames
  } finally {
    URL.revokeObjectURL(url)
  }
}
