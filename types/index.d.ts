declare module 'claude-code' {
  interface PluginState {
    'meta-status': {
      rows: { kind: string; cat: string; age: string; who: string; text: string; key: string }[]
      head: string
      summary: string
      prompts: string[]
      hidden: boolean
      agents: { who: string; name: string; desc: string; age: string; lane: string; id?: string; now?: string; detail?: string[]; pid?: number; kind?: 'claude' | 'codex'; sec?: number; sid?: string; depth?: number }[]
    }
  }
}
