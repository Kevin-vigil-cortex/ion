/**
 * Minimal wire shapes for the xAI Responses API (`/v1/responses`). Only the
 * fields this harness relies on are typed; unknown fields pass through.
 */

export interface ResponsesTextPart {
  type: 'input_text'
  text: string
}

/** Image input content part. `image_url` accepts a URL or a base64 data URI. */
export interface ResponsesImagePart {
  type: 'input_image'
  image_url: string
  detail?: 'low' | 'high' | 'auto'
}

/** Document attached via the Files API (`file_id`) or a public URL. */
export interface ResponsesFilePart {
  type: 'input_file'
  file_id?: string
  file_url?: string
}

export type ResponsesContentPart = ResponsesTextPart | ResponsesImagePart | ResponsesFilePart

export interface ResponsesInputMessage {
  role: 'system' | 'developer' | 'user' | 'assistant'
  content: string | ResponsesContentPart[]
}

export interface ResponsesFunctionCall {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

export interface ResponsesFunctionCallOutput {
  type: 'function_call_output'
  call_id: string
  output: string
}

export interface ResponsesReasoningItem {
  type: 'reasoning'
  id: string
  encrypted_content: string
  summary?: unknown
}

export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCall
  | ResponsesFunctionCallOutput
  | ResponsesReasoningItem

export interface ResponsesFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ResponsesRequest {
  model: string
  input: ResponsesInputItem[]
  tools?: ResponsesFunctionTool[]
  stream?: boolean
  temperature?: number
  max_output_tokens?: number
  parallel_tool_calls?: boolean
  /** Local-only: do not persist this turn on xAI's servers. */
  store?: boolean
  /** Request extra fields on output items (e.g. encrypted reasoning). */
  include?: string[]
  /** Cap how many tool calls Grok may emit in one response. */
  max_tool_calls?: number
  /** Reasoning depth for Grok reasoning models (grok-4.5 / grok-4.6+). */
  reasoning?: { effort: 'low' | 'medium' | 'high' | 'xhigh' }
  [extra: string]: unknown
}

/** A function-call item as it appears in a streamed `output_item.done` event. */
export interface StreamedFunctionCallItem {
  type: 'function_call'
  id?: string
  call_id?: string
  name: string
  arguments: string
}

/** Reasoning item as it appears in a streamed `output_item.done` event. */
export interface StreamedReasoningItem {
  type: 'reasoning'
  id?: string
  encrypted_content?: string
  summary?: unknown
}

export interface ModelListResponse {
  data?: Array<{ id: string }>
}
