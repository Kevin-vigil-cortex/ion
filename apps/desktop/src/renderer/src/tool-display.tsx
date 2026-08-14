import {
  FileText,
  FilePen,
  FolderTree,
  Search,
  TerminalSquare,
  Globe,
  Camera,
  MousePointerClick,
  Keyboard,
  MonitorDot,
  GitBranch,
  Bug,
  Sparkles,
  Plug
} from 'lucide-react'

/** [while running, when finished] verb forms per tool. */
const VERBS: Record<string, [string, string]> = {
  read_file: ['Reading', 'Read'],
  write_file: ['Writing', 'Wrote'],
  edit_file: ['Editing', 'Edited'],
  list_dir: ['Listing', 'Listed'],
  glob: ['Searching', 'Searched'],
  grep: ['Searching', 'Searched'],
  run_terminal: ['Running', 'Ran'],
  find_path: ['Searching for', 'Searched for'],
  git_diff: ['Diffing', 'Diffed'],
  git_commit: ['Committing', 'Committed'],
  get_diagnostics: ['Checking', 'Checked'],
  read_skill: ['Reading skill', 'Read skill'],
  open_workspace: ['Opening workspace', 'Opened workspace'],
  save_memory: ['Saving memory', 'Saved memory'],
  browser_navigate: ['Opening', 'Opened'],
  browser_snapshot: ['Reading page', 'Read page'],
  browser_click: ['Clicking', 'Clicked'],
  browser_type: ['Typing', 'Typed'],
  browser_press_key: ['Pressing', 'Pressed'],
  browser_scroll: ['Scrolling', 'Scrolled'],
  browser_screenshot: ['Taking screenshot', 'Took screenshot'],
  browser_back: ['Going back', 'Went back'],
  computer_screenshot: ['Taking screenshot', 'Took screenshot'],
  computer_click: ['Clicking', 'Clicked'],
  computer_move_mouse: ['Moving mouse', 'Moved mouse'],
  computer_type: ['Typing', 'Typed'],
  computer_press_key: ['Pressing', 'Pressed'],
  computer_scroll: ['Scrolling', 'Scrolled']
}

export function parseArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function s(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function objectFor(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return s(args.path)
    case 'list_dir':
      return s(args.path) || '.'
    case 'glob':
    case 'grep':
      return s(args.pattern)
    case 'run_terminal':
      return s(args.command)
    case 'git_diff':
      return args.staged === true ? '--staged' : ''
    case 'git_commit':
      return s(args.message).slice(0, 48)
    case 'get_diagnostics':
      return Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === 'string').join(' ') : ''
    case 'read_skill':
      return s(args.file) ? `${s(args.name)} ${s(args.file)}` : s(args.name)
    case 'find_path':
      return args.query !== undefined ? `"${s(args.query)}"` : ''
    case 'open_workspace':
      return basename(s(args.path))
    case 'browser_navigate':
      return s(args.url)
    case 'save_memory':
      return s(args.scope)
    default:
      if (name.startsWith('mcp_')) return name.replace(/^mcp_/, '').replace(/_/g, '/')
      return ''
  }
}

export function verbFor(name: string, running: boolean, fallback: string): string {
  if (name.startsWith('mcp_')) return running ? 'Calling' : 'Called'
  const verbs = VERBS[name]
  return verbs ? verbs[running ? 0 : 1] : fallback
}

export function iconFor(name: string): React.JSX.Element {
  switch (name) {
    case 'read_file':
      return <FileText size={13} />
    case 'write_file':
    case 'edit_file':
      return <FilePen size={13} />
    case 'list_dir':
    case 'open_workspace':
      return <FolderTree size={13} />
    case 'glob':
    case 'grep':
    case 'find_path':
      return <Search size={13} />
    case 'run_terminal':
      return <TerminalSquare size={13} />
    case 'git_diff':
    case 'git_commit':
      return <GitBranch size={13} />
    case 'get_diagnostics':
      return <Bug size={13} />
    case 'read_skill':
      return <Sparkles size={13} />
    case 'browser_screenshot':
    case 'computer_screenshot':
      return <Camera size={13} />
    case 'browser_click':
    case 'computer_click':
    case 'computer_move_mouse':
      return <MousePointerClick size={13} />
    case 'browser_type':
    case 'browser_press_key':
    case 'computer_type':
    case 'computer_press_key':
      return <Keyboard size={13} />
    default:
      if (name.startsWith('mcp_')) return <Plug size={13} />
      if (name.startsWith('browser_')) return <Globe size={13} />
      if (name.startsWith('computer_')) return <MonitorDot size={13} />
      return <TerminalSquare size={13} />
  }
}
