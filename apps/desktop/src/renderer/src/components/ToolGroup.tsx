import ToolCard from './ToolCard'
import type { UiTool } from '../store'

/**
 * A run of consecutive tool calls: a plain stack of slim activity lines,
 * no card chrome — the working phase should read like a quiet log.
 */
export default function ToolGroup({ tools }: { tools: UiTool[] }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {tools.map((tool) => (
        <ToolCard key={tool.id} tool={tool} />
      ))}
    </div>
  )
}
