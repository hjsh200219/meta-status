import { test, expect, mock } from 'claude-code/testing'
import { actOf, editWarning, parsePs, resultOf, subcommand, taskLine, transcriptDetail } from './register'

const out = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const CFG = '/h/.claude'
const DIR = `${CFG}/open-loops`

// 메모리 위 가짜 PC: 파일·git 상태·시계
function world(opts: { legacy?: boolean; inRepo?: boolean; cwd?: string; env?: Record<string, string>; noSh?: boolean } = {}) {
  const env: Record<string, string> = opts.env ?? { HOME: '/h', CLAUDE_CONFIG_DIR: CFG, TMUX_PANE: '%1' }
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const w = { files, mtimes, stats: [] as string[], dirty: [' M a.ts', '?? b.ts', ' M c.ts'], ahead: 2, clock: 1_000_000_000_000 }
  function run(argv: readonly string[]) {
    const cmd = argv.join(' ')
    // 모든 git 호출은 남의 repo 설정(fsmonitor·훅)을 끄고 돈다
    if (argv[0] === 'git' && !cmd.includes('core.fsmonitor=false')) throw new Error(`안전 옵션 없는 git: ${cmd}`)
    // Windows: sh·ps·tmux 가 없다 — 실행 자체가 실패한다
    if (cmd.includes('tmux')) return out('DevOps1\n')
    if (argv[0] === 'python3' && argv.includes('list')) return out('[{"kind":"note"},{"kind":"note"},{"kind":"watch"}]')
    if (opts.inRepo === false) return out('', 128)
    if (cmd.includes('branch --show-current')) return out('main\n')
    if (cmd.includes('remote get-url')) return out('git@github.com:me/workspace.git\n')
    if (cmd.includes('--show-toplevel')) return out('/h/workspace\n')
    if (cmd.includes('rev-list')) return out(`${w.ahead}\n`)
    if (cmd.includes('status --porcelain')) return out(w.dirty.map(l => l + '\n').join(''))
    return out('', 1)
  }
  return {
    w,
    install(on: any) {
      on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
      for (const ev of ['PostToolUse', 'Stop', 'SessionStart', 'PreToolUse']) on(`classic.${ev}`, () => ({}))
      on('command.register', () => ({ value: undefined }))
      on('tool.register', () => ({ value: { tool: 'x' } }))
      on('clock.now', () => ({ value: w.clock }))
      on('session.id', () => ({ value: 'me-session' }))
      on('session.root', () => ({ value: '/h/workspace' }))
      on('session.cwd', () => ({ value: opts.cwd ?? '/h/workspace' }))
      on('process.run', ($: any, e: any) => opts.noSh && ['sh', 'tmux', 'ps'].includes(e.argv[0]) ? { deny: `Command '${e.argv[0]}' not found` } : { value: run(e.argv) })
      on('env.get', ($: any, e: any) => ({ value: env[e.name] }))
      on('fs.exists', ($: any, e: any) => ({ value: opts.legacy ? true : files.has(e.path) }))
      on('fs.read', ($: any, e: any) => files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' })
      on('fs.write', ($: any, e: any) => { files.set(e.path, e.text); return { value: undefined } })
      on('fs.stat', ($: any, e: any) => (w.stats.push(e.path), mtimes.has(e.path)) ? { value: { mtimeMs: mtimes.get(e.path) } } : { deny: 'ENOENT' })
      on('fs.list', ($: any, e: any) => {
        const pre = e.path.endsWith('/') ? e.path : e.path + '/'
        const names = [...files.keys()].filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('/'))
        return { value: names.map(k => ({ name: k.slice(pre.length), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
      })
    },
    items: () => [...files].filter(([k]) => k.startsWith(`${DIR}/items/`)).map(([, v]) => JSON.parse(v)),
  }
}

// 세션을 시작하고, 표시될 한 줄을 /where 로 다시 읽는 함수를 돌려준다
async function status($: any, on: any) {
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '/h/workspace', surface: 'terminal', isInteractive: true })
  return async () => ((await $.command.run({ command: 'where', args: '' })) as any).text as string
}

test('상태줄: repo·브랜치·↑✎·열린 일 전체 개수', async ($, on) => {
  const g = world()
  g.install(on)
  g.w.files.set(`${DIR}/items/n.json`, JSON.stringify({ key: 'n', kind: 'note', ts: 1, text: '배포 뒤 확인' }))
  const shown = await status($, on)
  expect(await shown()).toBe('workspace · main ↑2 ✎3 · 열린 일 1')
})

test('repo 밖: 폴더만', async ($, on) => {
  const g = world({ inRepo: false, cwd: '/tmp/x' })
  g.install(on)
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '/tmp/x', surface: 'terminal', isInteractive: true })
  expect(((await $.command.run({ command: 'where', args: '' } as any)) as any).text).toBe('/tmp/x')
})

test('전환 모드: 원본 스크립트 장부를 읽는다 · OMC 요약이 있으면 줄 끝에', async ($, on) => {
  const g = world({ legacy: true })
  g.install(on)
  g.w.files.set('/h/workspace/.omc/state/session-summary-me-session.json', JSON.stringify({ summary: 'status 입력창 위로' }))
  const shown = await status($, on)
  expect(await shown()).toBe('workspace · main ↑2 ✎3 · 열린 일 3 · status 입력창 위로')
})

test('세션 제목 훅의 luna 주제가 있으면 OMC 요약 대신 줄 끝에', async ($, on) => {
  const g = world({ legacy: true })
  g.install(on)
  g.w.files.set('/h/workspace/.omc/state/session-summary-me-session.json', JSON.stringify({ summary: '멈춘 OMC 요약' }))
  g.w.files.set('/h/.claude/session-title/sessions/me-session.json', JSON.stringify({ topic: '토큰 사용량 원인 분석' }))
  const shown = await status($, on)
  expect(await shown()).toBe('workspace · main ↑2 ✎3 · 열린 일 3 · 토큰 사용량 원인 분석')
})

test('레인 세션은 lane-status 의 luna 주제를 줄 끝에', async ($, on) => {
  const g = world({ legacy: true })
  g.install(on)
  g.w.files.set('/h/workspace/.omc/state/session-summary-me-session.json', JSON.stringify({ summary: '멈춘 OMC 요약' }))
  g.w.files.set('/h/.claude/lane-status/DevOps1.json', JSON.stringify({ session_id: 'other', topic: '남의 레인' }))
  g.w.files.set('/h/.claude/lane-status/Secretary.json', JSON.stringify({ session_id: 'me-session', topic: '600k 적용' }))
  const shown = await status($, on)
  expect(await shown()).toBe('workspace · main ↑2 ✎3 · 열린 일 3 · 600k 적용')
})

test('Stop 이 미커밋·미푸시를 남기고, git 이 깨끗해지면 스스로 닫힌다', async ($, on) => {
  const g = world()
  g.install(on)
  const shown = await status($, on)
  // 이 세션이 파일 하나를 고쳤다
  await $.classic.PostToolUse({ session_id: 's1', transcript_path: '/t/s1.jsonl', tool_name: 'Edit', tool_input: { file_path: '/h/workspace/a.ts' }, tool_response: {}, tool_use_id: 'u1' } as any)
  await $.classic.Stop({ session_id: 's1', stop_hook_active: false, last_assistant_message: '배포했습니다. 운영 화면은 확인하지 못했습니다.' } as any)
  const kinds = g.items().map(i => i.kind).sort()
  expect(kinds).toEqual(['uncommitted', 'unpushed', '추정'])
  await $.command.run({ command: 'where', args: '' } as any).catch(() => undefined)
  // 커밋·push 를 마쳤다
  g.w.dirty = []
  g.w.ahead = 0
  await $.session.start({ cwd: '/h/workspace', surface: 'terminal', isInteractive: true })
  expect(await shown()).toBe('workspace · main')
  const open = g.items().filter(i => !i.closed).map(i => i.kind)
  expect(open).toEqual(['추정']) // 추정은 사람이 닫는다(목록·상태줄엔 안 보임)
})

test('다른 세션이 15분 안에 고친 파일이면 경고를 문맥에 넣는다', async ($, on) => {
  const g = world()
  g.install(on)
  g.w.files.set(`${DIR}/edits/other.json`, JSON.stringify({ transcript: '/t/other.jsonl', lane: 'DevOps2', paths: { '/h/workspace/a.ts': g.w.clock / 1000 - 120 } }))
  g.w.mtimes.set('/t/other.jsonl', g.w.clock - 60_000)
  // 판정 함수에 가짜 PC 를 직접 물린다(테스트의 $ 엔 clock 이 없다)
  const fake = {
    clock: { now: async () => g.w.clock },
    fs: {
      list: async (d: string) => [...g.w.files.keys()].filter(k => k.startsWith(d + '/')).map(k => ({ name: k.slice(d.length + 1) })),
      read: async (f: string) => g.w.files.get(f) ?? Promise.reject(new Error('ENOENT')),
      stat: async (f: string) => ({ mtimeMs: g.w.mtimes.get(f) }),
    },
  }
  const msg = await editWarning(fake as any, { dir: DIR }, 'me', '/h/workspace/a.ts')
  expect(await editWarning(fake as any, { dir: DIR }, 'other', '/h/workspace/a.ts')).toBeUndefined() // 자기 편집엔 경고 없음
  const ctx = [msg ?? '']
  expect(ctx.join('\n')).toContain('[동시 편집] a.ts 는 DevOps2 세션(other)이 2분 전에 고쳤습니다 — 그 세션은 지금도 활동 중입니다')
})

test('Edit 직전 hook 이 다른 세션 편집을 경고로 붙인다(mod 장부 모드)', async ($, on) => {
  const g = world()
  g.install(on)
  g.w.files.set(`${DIR}/edits/other.json`, JSON.stringify({ transcript: '/t/other.jsonl', lane: 'DevOps2', paths: { '/h/workspace/a.ts': g.w.clock / 1000 - 120 } }))
  g.w.mtimes.set('/t/other.jsonl', g.w.clock - 60_000)
  // 경고 문장은 모델 문맥으로만 가서 도구 결과엔 안 보인다 — 판정이 상대 세션 기록까지 읽었는지로 본다
  const stats = g.w.stats
  on('tool.call', () => ({ result: 'ok' }))
  await status($, on)
  stats.length = 0
  await $.tool.call({ tool: 'Read', file_path: '/h/workspace/a.ts' } as any)
  expect(stats).toEqual([]) // 편집 도구가 아니면 보지 않는다
  await $.tool.call({ tool: 'Edit', file_path: '/h/workspace/a.ts', old_string: 'a', new_string: 'b' } as any)
  expect(stats).toEqual(['/t/other.jsonl'])
})

test('open_loop_add 도구로 적고 open_loop_close 로 닫는다', async ($, on) => {
  const g = world()
  g.install(on)
  await status($, on)
  await $.tool.call({ tool: 'mcp__meta-status__open_loop_add', input: { key: 'deploy-check', text: '내일 09시 배포 결과 확인' } } as any)
  expect(g.items()).toMatchObject([{ key: 'deploy-check', kind: 'note', lane: 'DevOps1', text: '내일 09시 배포 결과 확인' }])
  await $.tool.call({ tool: 'mcp__meta-status__open_loop_close', input: { key: 'deploy-check' } } as any)
  expect(g.items()[0].closed).toBe(true)
})

test('/loops 는 패널을 열고(종류·나이·누가·키) 다시 부르면 닫는다', async ($, on) => {
  const g = world()
  g.install(on)
  g.w.files.set(`${DIR}/items/a.json`, JSON.stringify({ key: 'a', kind: 'note', ts: g.w.clock / 1000 - 7200, session: 'abcdef1234', text: '배포 뒤 확인' }))
  g.w.files.set(`${DIR}/items/b.json`, JSON.stringify({ key: 'b', kind: 'watch', ts: g.w.clock / 1000 - 60, lane: 'DevOps2', text: '알림 확인' }))
  // 키별 가짜 상태 저장소(rows·head 를 따로)
  const store = new Map<string, unknown>()
  let version = 0
  on('state.get', ($: any, e: any) => ({ value: { value: store.get(e.key), version } }))
  on('state.set', ($: any, e: any) => { store.set(e.key, e.value); version += 1; return { value: { isSet: true, version } } })
  let opened: any
  let closed: any
  let panes: { id: string }[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', ($: any, e: any) => { opened = e; panes = [{ id: e.id }]; return { value: { isPlaced: true } } })
  on('ui.close', ($: any, e: any) => { closed = e; panes = []; return { value: undefined } })
  await status($, on)
  const r: any = await $.command.run({ command: 'loops', args: '' } as any)
  expect(opened).toMatchObject({ id: 'open-loops', title: '열린 일 2' })
  expect(r.text).toBe('열린 일 2건 — /loops 다시 입력하면 닫힘')
  expect(store.get('rows')).toEqual([
    { kind: '메모', age: '2시간 전', who: '세션 abcdef12', text: '배포 뒤 확인', key: 'a' },
    { kind: '확인 대기', age: '1분 전', who: 'DevOps2', text: '알림 확인', key: 'b' },
  ])
  // 다시 부르면 닫는다
  const r2: any = await $.command.run({ command: 'loops', args: '' } as any)
  expect(closed).toMatchObject({ id: 'open-loops' })
  expect(r2.text).toBe('열린 일 패널을 닫았습니다')
})

test('입력창 위 「열린 일 N」 버튼을 누르면 패널이 열리고 다시 누르면 닫힌다', async ($, on) => {
  const g = world()
  g.install(on)
  g.w.files.set(`${DIR}/items/a.json`, JSON.stringify({ key: 'a', kind: 'note', ts: 1, text: '배포 뒤 확인' }))
  let panes: { id: string }[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', ($: any, e: any) => { panes = [{ id: e.id }]; return { value: { isPlaced: true } } })
  on('ui.close', () => { panes = []; return { value: undefined } })
  await status($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    panes = []
    await ($ as any).ui.mount({ plugin: 'meta-status', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 5 } })
    await ($ as any).ui.press({ plugin: 'meta-status', key: 'loops', surface })
    expect(panes).toEqual([{ id: 'open-loops' }])
    await ($ as any).ui.press({ plugin: 'meta-status', key: 'loops', surface })
    expect(panes).toEqual([])
  }
})

test('에이전트 감지: 이 세션의 edb-p·delegate codex exec·맨 claude -p 는 잡고, 다른 세션·HUD 요약·상주 Codex·위임 안의 위임은 버린다', () => {
  const ps = [
    '  100     1 05:00:00 /x/claude-fixed/claude --resume abc --remote-control',          // 레인(DevOps1)
    '  200   100    12:00 /bin/zsh -c source snapshot; python3 /h/.local/bin/edb-p 필첵 PRD 검토해줘',
    '  201   200    12:00 python3 /h/.local/bin/edb-p 필첵 PRD 검토해줘',
    '  202   201    11:59 /x/claude-fixed/claude -p --output-format stream-json --verbose', // edb
    '  203   202    05:00 /x/claude-fixed/claude -p 하위 작업',                             // 위임 안의 위임 → 버림
    '  300   100    01:03:10 sh /h/.claude/hud/account-line.sh',
    '  301   300    01:03:10 node /h/omc/scripts/session-summary.mjs t.jsonl',
    '  302   301    00:20 claude -p You are a session labeler',                                // HUD 요약 → 버림
    '  400   100    03:00 python3 /h/.local/bin/delegate --engine codex',
    '  401   400    02:59 /x/codex exec -C /h/workspace/pillcheck-app --skip-git-repo-check -s workspace-write -o /tmp/o.md -', // codex
    '  500     1 2-09:54:47 /Applications/ChatGPT.app/x/codex app-server --listen stdio://',   // 상주 → 버림
    '  600   100    00:40 /x/claude-fixed/claude -p 이 함수 테스트 써줘 --permission-mode bypassPermissions', // claude-as/맨 claude -p
    '  700     1 05:00:00 /x/claude-fixed/claude --resume def',                                 // 다른 레인(DevOps2)
    '  701   700    03:00 /bin/zsh -c source snapshot; python3 /h/.local/bin/edb-p 남의 작업',
    '  702   701    03:00 /x/claude-fixed/claude -p 남의 작업',                                     // 다른 세션 → me 를 주면 버림
    '  800   100    00:00 sh -c echo $PPID',                                                     // mod 가 띄운 sh
  ].join('\n')
  const panes = '100 DevOps1\n700 DevOps2\n'
  expect(parsePs(ps, panes).map(a => a.lane)).toContain('DevOps2')
  // 위임 안의 위임(203)은 따로 세지 않고 「지금」으로 보인다
  expect(parsePs(ps, panes, 100)[0]?.detail).toEqual(['pid 202', '지금 /x/claude-fixed/claude -p 하위 작업 · 5분', 'python3 /h/.local/bin/edb-p 필첵 PRD 검토해줘'])
  expect(parsePs(ps, panes, 100).map(({ detail, pid, kind, sec, ...a }) => a)).toEqual([
    { who: 'edb', name: 'edb-p', desc: '필첵 PRD 검토해줘', age: '11분', lane: 'DevOps1' },
    { who: 'codex', name: 'delegate', desc: 'pillcheck-app', age: '2분', lane: 'DevOps1' },
    { who: 'claude', name: 'claude -p', desc: '이 함수 테스트 써줘 --permission-mode bypassPermissions', age: '방금', lane: 'DevOps1' },
  ])
})

test('/workers 는 에이전트 패널을 열고 다시 부르면 닫는다', async ($, on) => {
  const g = world()
  g.install(on)
  let panes: { id: string }[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', ($: any, e: any) => { panes = [{ id: e.id }]; return { value: { isPlaced: true } } })
  on('ui.close', () => { panes = []; return { value: undefined } })
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'executor', description: '테스트 보강', status: 'running' }, { id: 'a2', type: 'explore', description: '끝남', status: 'completed' }] }))
  await status($, on)
  const r: any = await $.command.run({ command: 'workers', args: '' } as any)
  expect(panes).toEqual([{ id: 'agents' }])
  expect(r.text).toBe('에이전트 1개 — /workers 다시 입력하면 닫힘')
  const r2: any = await $.command.run({ command: 'workers', args: '' } as any)
  expect(panes).toEqual([])
  expect(r2.text).toBe('에이전트 패널을 닫았습니다')
})

test('/loops close 번호 — 패널 순서(레인별 · 큰 묶음 먼저 · 최신 위)의 번호로 닫는다', async ($, on) => {
  const g = world()
  g.install(on)
  const t = g.w.clock / 1000
  g.w.files.set(`${DIR}/items/a.json`, JSON.stringify({ key: 'a', kind: 'note', ts: t - 7200, lane: 'DevOps2', text: '옛 일 — 설명 (C0AKC)' }))
  g.w.files.set(`${DIR}/items/b.json`, JSON.stringify({ key: 'b', kind: 'note', ts: t - 60, lane: 'DevOps2', text: '새 일' }))
  g.w.files.set(`${DIR}/items/c.json`, JSON.stringify({ key: 'c', kind: 'note', ts: t - 30, lane: 'DevOps1', text: '다른 레인' }))
  await status($, on)
  // 순서: DevOps2[b(1), a(2)] · DevOps1[c(3)] → 2번 = a
  const r: any = await $.command.run({ command: 'loops', args: 'close 2' } as any)
  expect(r.text).toBe('닫음: a')
  expect(g.items().filter(i => i.closed).map(i => i.key)).toEqual(['a'])
})

test('actOf — 도구 호출을 「도구 대표값」 한 줄로', () => {
  expect(actOf('Read', { file_path: '/h/workspace/a/register.tsx' })).toBe('Read register.tsx')
  expect(actOf('Bash', { command: 'git status', description: '상태 확인' })).toBe('Bash 상태 확인')
  expect(actOf('Grep', { pattern: 'scanAgents' })).toBe('Grep scanAgents')
  expect(actOf('mcp__x__y', {})).toBe('x__y')
})

test('서브에이전트가 도구를 부르면 패널 줄에 「지금」이 붙는다', async ($, on) => {
  const g = world()
  g.install(on)
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'executor', description: '테스트 보강', status: 'running' }] }))
  on('tool.call', () => ({ result: 'ok' }))
  await status($, on)
  await $.tool.call({ tool: 'Read', file_path: '/x/foo.ts', agentId: 'a1' } as any)
  await $.tool.call({ tool: 'Grep', pattern: 'bar', agentId: 'a1' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await ($.ui as any).mount({ plugin: 'meta-status', surface, component: 'Pane', props: {}, requestId: 'agents' })
    expect(await ui.find({ type: 'Text', text: /지금 Grep bar · 2번째/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/workers 는 이름·종류·모델·지시·마지막 말·최근 도구(✓✗ 실패 이유…)·횟수를 보인다', async ($, on) => {
  const g = world()
  g.install(on)
  let panes: { id: string }[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', ($: any, e: any) => { panes = [{ id: e.id }]; return { value: { isPlaced: true } } })
  on('ui.close', () => { panes = []; return { value: undefined } })
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'executor', name: 'fixer', description: '테스트 보강', status: 'running' }] }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('session.messages', () => ({ value: [
    { role: 'assistant', text: '먼저 파일을 읽겠습니다', toolUses: [
      { tool_use_id: 't1', tool: 'Read', input: { file_path: '/x/a.ts' }, text: 'ok', durationMs: 300 },
      { tool_use_id: 't2', tool: 'Bash', input: { command: 'npm test' }, text: 'Exit code 1\nexpected 200, got 401', isError: true, durationMs: 2500 },
    ] },
    { role: 'user', text: '', toolUses: [] },
    { role: 'assistant', text: '테스트가 깨져서 원인을 찾습니다', toolUses: [{ tool_use_id: 't3', tool: 'Grep', input: { pattern: 'foo' } }] },
  ] }))
  await status($, on)
  await $.agent.spawn({ prompt: 'auth.spec.ts 의\n실패 원인을 찾아 고쳐라', description: '테스트 보강', subagentType: 'executor', background: true } as any)
  await $.command.run({ command: 'workers', args: '' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await ($.ui as any).mount({ plugin: 'meta-status', surface, component: 'Pane', props: {}, requestId: 'agents' })
    for (const line of ['fixer · executor · 테스트 보강', '모델 claude-sonnet-5-5 · 백그라운드', '지시 auth.spec.ts 의 실패 원인을 찾아 고쳐라', '말 테스트가 깨져서 원인을 찾습니다', '✓ Read a.ts 300ms', '✗ Bash npm test 2.5초 → Exit code 1 expected 200, got 401', '… Grep foo', '도구 3번 · 메시지 3개'])
      expect(await ui.find({ type: 'Text', text: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeDefined()
    await ui.unmount()
  }
})

test('subcommand — 앞 옵션을 건너뛴 codex 하위 명령', () => {
  expect(subcommand('/x/codex exec -C /h/a -')).toBe('exec')
  expect(subcommand('/x/codex --yolo exec -C /h/a -s workspace-write -m gpt-6-astra -')).toBe('exec')
  expect(subcommand('/x/codex -c cli_auth_credentials_store="file" --remote unix:///s.sock resume 01a')).toBe('resume')
  expect(subcommand('/x/codex exec-server --remote https://x')).toBe('exec-server')
  expect(subcommand('/x/codex --yolo resume')).toBe('resume')
})

test('에이전트 감지: 셸 별칭이 붙인 codex --yolo exec 도 잡는다', () => {
  const ps = [
    '  100     1 05:00:00 /x/claude-fixed/claude --resume abc --remote-control',
    '  500   100    04:41 /bin/zsh -c source snapshot; codex exec -C /h/workspace/meta-plan -',
    '  501   500    04:41 /h/.local/bin/codex --yolo exec -C /h/workspace/meta-plan -s workspace-write -m gpt-6-astra -c model_reasoning_effort=high -',
    '  600     1    10:00 /h/.local/bin/codex --yolo resume',
  ].join('\n')
  const [a] = parsePs(ps, '100 DevOps1\n', 100)
  expect(a && (({ detail, pid, kind, sec, ...x }) => x)(a)).toEqual({ who: 'codex', name: 'exec', desc: 'meta-plan', age: '4분', lane: 'DevOps1' })
  expect(a?.detail?.[0]).toBe('pid 501 · 모델 gpt-6-astra · 위치 /h/workspace/meta-plan')
})

test('바깥 위임: 10초 넘어 띄운 가장 새 자식을 「지금」으로, 시작 직후 뜬 MCP 서버는 뺀다 · 긴 작업은 「지시」로', () => {
  const ps = [
    '  100     1 05:00:00 /x/claude --resume abc',
    '  200   100    03:00 python3 /h/.local/bin/edb-p',
    '  201   200    03:00 /x/claude-fixed/claude -p --output-format stream-json --model opus',
    '  300   100    01:00 /x/claude-fixed/claude -p git commit -m fix 해줘',               // 작업 원문의 -m 은 모델 아님
    '  202   201    02:58 node /h/mcp/server.js',                                          // 시작 직후 → 뺌
    '  203   201    00:40 /bin/zsh -c source /h/.claude/shell-snapshots/s.sh && eval npm test',
    '  204   203    00:39 npm test',
  ].join('\n')
  const long = '사용자 지시: ' + '가'.repeat(80)
  expect(parsePs(ps, '', 100, new Map([[200, long]]))[0]?.detail?.slice(0, 3)).toEqual([
    'pid 201 · 모델 opus', `지시 ${'가'.repeat(80)}`, '지금 npm test · 방금',
  ])
  expect(parsePs(ps, '', 100)[1]?.detail?.[0]).toBe('pid 300')
})

test('resultOf — 실패는 이유, 성공은 첫 줄(+남은 줄), Read 는 줄 수', () => {
  expect(resultOf({ tool: 'Bash', input: {}, text: 'a\nb\nc', done: true })).toBe('a (+2줄)')
  expect(resultOf({ tool: 'Read', input: {}, text: '1\tx\n2\ty', done: true })).toBe('2줄')
  expect(resultOf({ tool: 'Bash', input: {}, text: 'Exit 1\nboom', isError: true, done: true })).toBe('Exit 1 boom')
  expect(resultOf({ tool: 'exec_command', input: {}, text: 'Script completed\nWall time 0.2 seconds\nOutput:\nok', done: true })).toBe('ok')
  expect(resultOf({ tool: 'Grep', input: {}, done: false })).toBe('')
})

test('transcriptDetail — Claude 기록과 Codex rollout 끝부분에서 말·도구·결과', () => {
  const claude = [
    '{"type":"assistant","message":{"content":[{"type":"text', // 잘린 첫 줄
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '테스트를 돌립니다' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: '3 passed\ndone' }] }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u2', name: 'Read', input: { file_path: '/x/a.ts' } }] } }),
  ].join('\n')
  expect(transcriptDetail(claude)).toEqual(['말 테스트를 돌립니다', '✓ Bash npm test → 3 passed (+1줄)', '… Read a.ts', '도구 2번(최근 기록)'])
  const codex = [
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:"git status \\"x\\""}))' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: 'clean' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'shell', arguments: '{"cmd":"ls"}' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '정리했습니다' }] } }),
  ].join('\n')
  expect(transcriptDetail(codex)).toEqual(['말 정리했습니다', '✓ exec_command git status x → clean', '… shell ls', '도구 2번(최근 기록)'])
  expect(transcriptDetail('not json')).toEqual([])
})

test('/workers 는 서브에이전트가 띄운 서브에이전트를 부모 아래 들여 쓴다', async ($, on) => {
  const g = world()
  g.install(on)
  let panes: { id: string }[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', ($: any, e: any) => { panes = [{ id: e.id }]; return { value: { isPlaced: true } } })
  on('ui.close', () => { panes = []; return { value: undefined } })
  on('agent.list', () => ({ value: [
    { id: 'c1', type: 'Explore', description: '자식 검색', status: 'running', parentId: 'p1' },
    { id: 'p1', type: 'executor', description: '부모 작업', status: 'running' },
    { id: 'o1', type: 'Plan', description: '부모 끝난 고아', status: 'running', parentId: 'gone' },
    { id: 'x1', type: 'Plan', description: '고리 작업', status: 'running', parentId: 'x1' },
  ] }))
  on('session.messages', () => ({ value: [] }))
  await status($, on)
  await $.command.run({ command: 'workers', args: '' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await ($.ui as any).mount({ plugin: 'meta-status', surface, component: 'Pane', props: {}, requestId: 'agents' })
    const lines = (await ui.findAll({ type: 'Text', text: /작업|검색|고아/ })).map((t: any) => t.text)
    expect(lines).toEqual(['executor · 부모 작업', '└ Explore · 자식 검색', 'Plan · 부모 끝난 고아', 'Plan · 고리 작업'])
    await ui.unmount()
  }
})

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 5 } } as const

test('/meta-status off 면 입력창 위 줄을 그리지 않고 on 이면 다시 그린다', async ($, on) => {
  const g = world()
  g.install(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return h(Text, {}, '엔진 기본') })
  await status($, on)
  const shows = async () => {
    const ui = await ($ as any).ui.mount({ plugin: 'meta-status', surface: 'terminal', ...BAND })
    const hit = await ui.find({ type: 'Text', text: /workspace · main/ })
    await ui.unmount()
    return hit !== undefined
  }
  expect(await shows()).toBe(true)
  expect(((await $.command.run({ command: 'meta-status', args: 'off' } as any)) as any).text).toContain('껐습니다')
  expect(await shows()).toBe(false)
  expect(((await $.command.run({ command: 'meta-status', args: '' } as any)) as any).text).toContain('꺼짐')
  await $.command.run({ command: 'meta-status', args: 'on' } as any)
  expect(await shows()).toBe(true)
})

test('줄이 비어 있으면 그리면서 한 번 다시 읽는다(/clear·재로드 직후)', async ($, on) => {
  const g = world()
  g.install(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return h(Text, {}, '엔진 기본') })
  // session.start 를 거치지 않아 줄이 빈 상태 — /clear 직후와 같다
  const first = await ($ as any).ui.mount({ plugin: 'meta-status', surface: 'terminal', ...BAND })
  await first.unmount()
  await new Promise(r => setTimeout(r, 50))
  const ui = await ($ as any).ui.mount({ plugin: 'meta-status', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /workspace · main/ })).toBeDefined()
  await ui.unmount()
})

test('Windows(sh·ps·tmux 없음, HOME 대신 USERPROFILE): 상태 줄·/workers·/loops 가 산다', async ($, on) => {
  const g = world({ noSh: true, env: { USERPROFILE: 'C:\\Users\\pys' } })
  g.install(on)
  let panes: { id: string }[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', ($: any, e: any) => { panes = [{ id: e.id }]; return { value: { isPlaced: true } } })
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'executor', description: '테스트 보강', status: 'running' }] }))
  const shown = await status($, on)
  expect(await shown()).toBe('workspace · main ↑2 ✎3')
  expect(((await $.command.run({ command: 'workers', args: '' } as any)) as any).text).toBe('에이전트 1개 — /workers 다시 입력하면 닫힘')
  await $.command.run({ command: 'loops', args: 'add k 배포 확인' } as any)
  // macOS 시험 엔진은 C: 경로를 상대 경로로 보고 mod 폴더 앞에 붙인다 — 뒷부분만 본다
  const saved = [...g.w.files.keys()].filter(k => k.includes('C:/Users/pys/.claude/open-loops/items/'))
  expect(saved.length).toBe(1)
  expect(JSON.parse(g.w.files.get(saved[0])!).lane).toBe('')
})

test('요약 버튼을 누르면 이 세션 프롬프트 패널(태그·도구 결과·스킬 본문 제외, 최신 위)', async ($, on) => {
  const g = world({ legacy: true })
  g.install(on)
  g.w.files.set('/h/workspace/.omc/state/session-summary-me-session.json', JSON.stringify({ summary: 'status 입력창 위로' }))
  let panes: { id: string }[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', ($: any, e: any) => { panes = [{ id: e.id }]; return { value: { isPlaced: true } } })
  on('ui.close', () => { panes = []; return { value: undefined } })
  on('session.messages', () => ({ value: [
    { role: 'user', text: '<system-reminder>무시</system-reminder>첫 질문', toolUses: [] },
    { role: 'assistant', text: '네', toolUses: [] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'ok' }] },
    { role: 'user', text: 'Base directory for this skill: /x', toolUses: [] },
    { role: 'user', text: '<command-name>/clear</command-name><command-args></command-args>', toolUses: [] },
    { role: 'user', text: '<task-notification> <task-id>a1</task-id> <status>completed</status> </task-notification>', toolUses: [] },
    { role: 'user', text: '<task-notification>\n<task-id>a2</task-id>\n</task-notification>\n<system-reminder>x</system-reminder>', toolUses: [] },
    { role: 'user', text: '<future-tag>엔진이 넣음</future-tag>', toolUses: [] },
    { role: 'user', text: '[Request interrupted by user]', toolUses: [] },
    { role: 'user', text: '두 번째 질문', toolUses: [] },
  ] }))
  await status($, on)
  await ($ as any).ui.mount({ plugin: 'meta-status', surface: 'terminal', ...BAND })
  await ($ as any).ui.press({ plugin: 'meta-status', key: 'prompts', surface: 'terminal' })
  expect(panes).toEqual([{ id: 'prompts' }])
  const ui = await ($.ui as any).mount({ plugin: 'meta-status', surface: 'terminal', component: 'Pane', props: {}, requestId: 'prompts' })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  expect(texts.filter((t: string) => /질문|clear|무시|Base|task|엔진|Request/.test(t))).toEqual(['두 번째 질문', '/clear', '첫 질문'])
  await ui.unmount()
  await ($ as any).ui.press({ plugin: 'meta-status', key: 'prompts', surface: 'terminal' })
  expect(panes).toEqual([])
})

test('도구가 도는 동안 15초마다 에이전트를 다시 읽고, 끝나면 멈춘다 — 포그라운드 Bash 로 도는 /codex 도 잡힌다', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000_000 })
  let codexUp = false
  let scans = 0
  on('process.run', ($: any, e: any) => {
    if (e.argv[0] !== 'sh') return { value: out('', 1) }
    scans++
    const ps = ['  100     1 05:00:00 /x/claude --resume abc', ...(codexUp ? ['  401   100    00:30 /h/.local/bin/codex exec IMPORTANT -C /h/workspace -s read-only --json'] : [])]
    return { value: out(['100', ps.join('\n'), '', ''].join('\n@@\n')) }
  })
  on('agent.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  let release!: () => void
  on('env.get', () => ({ value: undefined }))
  for (const ev of ['PreToolUse', 'PostToolUse']) on(`classic.${ev}`, () => ({}))
  on('tool.call', () => new Promise(res => { release = () => res({ result: { text: 'ok' } }) }))
  const call = ($.tool as any).call({ tool: 'Bash', command: 'codex exec …' })
  await clock.advance(1)
  codexUp = true
  const before = scans
  await clock.advance(15_000)
  expect(scans).toBe(before + 1)
  release()
  await call
  codexUp = false
  const after = scans
  await clock.advance(60_000)
  expect(scans).toBe(after)
})

test('/codex 가 띄운 codex exec(프롬프트가 -C 앞) 도 이 세션 에이전트로 잡힌다', () => {
  const ps = [
    '  100     1 05:00:00 /x/claude --resume abc',
    '  300   100    00:40 /bin/zsh -c source snapshot; _gstack_codex_timeout_wrapper 600 codex exec',
    '  301   300    00:40 /opt/homebrew/bin/gtimeout 600 /h/.local/bin/codex exec IMPORTANT: Do NOT read -C /h/workspace -s read-only --json',
    '  302   301    00:40 /h/.local/bin/codex exec IMPORTANT: Do NOT read -C /h/workspace -s read-only --json',
  ].join('\n')
  expect(parsePs(ps, '', 100).map(a => [a.who, a.name, a.desc])).toEqual([['codex', 'exec', 'workspace']])
})

test('30초 넘게 도는 Bash 셸(백그라운드 gh run watch)은 «셸»로 잡고, 짧은 셸·위임을 품은 셸·다른 세션 셸은 뺀다', () => {
  const Z = '/bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && export X=1'
  const ps = [
    '  100     1 05:00:00 /x/claude --resume abc',
    `  726   100    12:33 ${Z}`,
    '  1490   726    12:24 gh run watch 37583790372 --exit-status --interval 60',
    `  800   100    00:05 ${Z}`,                                                   // 짧은 셸 → 버림
    '  801   800    00:05 ls',
    `  900   100    03:21 ${Z}`,                                                   // codex 를 품은 셸 → codex 로만
    `  901   900    03:21 ${Z}`,
    '  902   901    03:21 /opt/homebrew/bin/gtimeout 3600 codex exec resume 01a',
    '  903   902    03:21 codex exec resume 01a IMPORTANT',
    '  700     1 05:00:00 /x/claude --resume def',
    `  701   700    09:00 ${Z}`,                                                   // 다른 세션 → 버림
    '  702   701    09:00 sleep 600',
    '  950   100    00:00 sh -c echo $PPID',
  ].join('\n')
  expect(parsePs(ps, '100 DevOps1\n', 950).map(a => [a.who, a.name, a.desc, a.age, a.lane])).toEqual([
    ['codex', 'exec', '', '3분', 'DevOps1'],
    ['셸', 'Bash', 'gh run watch 37583790372 --exit-status --interval 60', '12분', 'DevOps1'],
  ])
})

test('작업을 파일(stdin)로 넘긴 delegate·edb-p 는 그 파일의 작업 한 줄을 보인다', () => {
  const ps = [
    '  100     1 05:00:00 /x/claude --resume abc',
    '  400   100    03:00 python3 /h/.local/bin/delegate',
    '  401   400    02:59 /x/codex exec -C /h/workspace/pc-web-ci-slim --skip-git-repo-check -s workspace-write -o /tmp/o.md -',
    '  500   100    01:00 python3 /h/.local/bin/edb-p',
    '  501   500    00:59 /x/claude-fixed/claude -p --output-format stream-json --verbose',
    '  600   100    00:30 python3 /h/.local/bin/delegate',                           // 파일 없음 → 종전처럼 폴더 이름
    '  601   600    00:29 /x/codex exec -C /h/workspace/adminsite -',
  ].join('\n')
  const stdins = new Map([
    [400, '작업 디렉터리: /h/workspace/pc-web-ci-slim\n\n사용자 지시: 「pillcheck CI 를 줄이는 6개를 적용해줘.」\npush 허락 아님'],
    [500, '/publish\n'],
  ])
  expect(parsePs(ps, '', 100, stdins).map(a => [a.name, a.desc])).toEqual([
    ['delegate', 'pillcheck CI 를 줄이는 6개를 적용해줘.'],
    ['edb-p', '/publish'],
    ['delegate', 'adminsite'],
  ])
  expect(taskLine('IMPORTANT: Do NOT read\n# 필첵 PRD 검토\n')).toBe('필첵 PRD 검토')
})
