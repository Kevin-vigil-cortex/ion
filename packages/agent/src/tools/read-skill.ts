import type { Tool, ToolResult } from './types'
import {
  discoverSkills,
  loadSkillBody,
  readSkillFile,
  type DiscoverSkillsOptions,
  type SkillMeta
} from '../skills'

export function createReadSkillTool(
  workspaceRoot: () => string | null,
  options?: DiscoverSkillsOptions
): Tool {
  return {
    name: 'read_skill',
    description:
      'Load a skill playbook by name (SKILL.md). Use when a listed skill matches the task. ' +
      'Optional file reads a companion in the skill folder (e.g. reference.md).',
    dangerous: false,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name from the Skills catalog (e.g. "review").' },
        file: {
          type: 'string',
          description: 'Optional file inside the skill folder. Defaults to SKILL.md.'
        }
      },
      required: ['name'],
      additionalProperties: false
    },
    summarize: (args) =>
      typeof args.file === 'string' && args.file
        ? `skill ${String(args.name ?? '')} ${args.file}`
        : `skill ${String(args.name ?? '')}`,
    async execute(args): Promise<ToolResult> {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!name) return { output: 'name is required.', isError: true }
      const skills = await discoverSkills(workspaceRoot(), options)
      const skill = findSkill(skills, name)
      if (!skill) {
        const names = skills.map((s) => s.name).join(', ') || '(none)'
        return { output: `Unknown skill "${name}". Available: ${names}`, isError: true }
      }
      try {
        const file = typeof args.file === 'string' ? args.file.trim() : ''
        const body = file && file.toLowerCase() !== 'skill.md'
          ? await readSkillFile(skill, file)
          : await loadSkillBody(skill)
        return {
          output: `# /${skill.name}\n\n${body}`,
          meta: { name: skill.name, source: skill.source }
        }
      } catch (err) {
        return {
          output: `Could not read skill: ${err instanceof Error ? err.message : String(err)}`,
          isError: true
        }
      }
    }
  }
}

function findSkill(skills: SkillMeta[], name: string): SkillMeta | undefined {
  const needle = name.replace(/^\//, '').toLowerCase()
  return skills.find((s) => s.name === needle)
}
