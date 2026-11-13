import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { SURVEY_ID, SURVEY_QUESTIONS, SurveyError, exportCsv, exportJson, validateSubmission } from '../src/survey/clinician-survey.ts'
import { TurnService } from '../src/turns/service.ts'

/** 一份答完所有必答题的合法提交。 */
function fullAnswers(): Record<string, unknown> {
  const a: Record<string, unknown> = {}
  for (const q of SURVEY_QUESTIONS) {
    if (q.type === 'single') a[q.id] = q.o![0]
    else if (q.type === 'multi') a[q.id] = [q.o![0]]
    else if (q.type === 'scale') a[q.id] = 4
    else a[q.id] = '希望 AI 不要改我的数字'
  }
  return a
}

describe('问卷校验', () => {
  it('不收工作单位：题目里没有单位这一题', () => {
    expect(SURVEY_QUESTIONS.some(q => /单位|医院|机构/.test(q.t))).toBe(false)
  })

  it('合法提交规整后保留答案，未答的题记为空', () => {
    const answers = fullAnswers()
    delete answers.q20
    const sub = validateSubmission({ consent: true, answers, other: {} })
    expect(sub.answers.q01).toBe(SURVEY_QUESTIONS[0]!.o![0])
    expect(sub.answers.q20).toBeNull()
  })

  it('必须同意说明', () => {
    expect(() => validateSubmission({ answers: fullAnswers() })).toThrow(SurveyError)
  })

  it('拒绝不存在的选项、超出上限和互斥选项同选', () => {
    expect(() => validateSubmission({ consent: true, answers: { q01: '院长' } })).toThrow(/选项无效/)
    const q16 = SURVEY_QUESTIONS.find(q => q.id === 'q16')!
    expect(() => validateSubmission({ consent: true, answers: { q16: q16.o!.slice(0, 4) } })).toThrow(/最多选 3 项/)
    expect(() => validateSubmission({ consent: true, answers: { q08: ['引错了文献', '以上都没有遇到过'] } })).toThrow(/不能和其他选项同时选/)
    expect(() => validateSubmission({ consent: true, answers: { q19: 7 } })).toThrow(/1–5/)
  })

  it('空问卷不收；「其他」说明只在选了「其他」时保留', () => {
    expect(() => validateSubmission({ consent: true, answers: {} })).toThrow(/还没有回答/)
    const sub = validateSubmission({ consent: true, answers: { q04: ['Word', '其他'], q05: ['EndNote'] }, other: { q04: 'Typora', q05: '不该保留' } })
    expect(sub.other).toEqual({ q04: 'Typora' })
  })

  it('CSV：多选题按选项展开成 0/1，含 BOM，逗号和引号被转义', () => {
    const sub = validateSubmission({ consent: true, answers: { ...fullAnswers(), q20: '他说："数字, 不能错"' } })
    const csv = exportCsv([{ id: 'r1', version: 'v', created_at: '2026-11-13T00:00:00.000Z', data: sub }])
    expect(csv.startsWith('﻿')).toBe(true)
    const [header, row] = csv.slice(1).trim().split('\r\n')
    expect(header).toContain('q04:Word')
    expect(header).toContain('q04:其他说明')
    const cols = header!.split(',')
    const vals = row!.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map(s => s.replace(/,$/, ''))
    expect(vals[cols.indexOf('q04:Word')]).toBe('1')
    expect(vals[cols.indexOf('q04:WPS')]).toBe('0')
    expect(row).toContain('"他说：""数字, 不能错"""')
  })

  it('JSON 导出带题目原文', () => {
    const sub = validateSubmission({ consent: true, answers: fullAnswers() })
    const out = exportJson([{ id: 'r1', version: 'v', created_at: 'x', data: sub }])
    expect(out.count).toBe(1)
    expect(out.questions.find(q => q.id === 'q01')?.question).toContain('职位')
  })
})

function env() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
  const mailer = { configured: true, available: true, mode: 'dev-mock' as const, async send() { return { success: true, mode: 'simulated' as const, messageId: 'm' } } }
  const accounts = new Accounts(store, { secret: 's', devMode: true, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: 's', baseMax: 300, minDelayMs: 0 }), mailer })
  const app = buildApi({
    docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient, renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-'))),
    accounts, devMode: true, devUser: 'dev',
  })
  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data: any = text
    try { data = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, data }
  }
  const register = async (username: string) => {
    const pow = solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge)
    return (await call('POST', '/api/auth/register', undefined, { username, password: 'password-123', pow })).data as { token: string }
  }
  return { store, call, register }
}

describe('问卷接口', () => {
  const path = `/api/public/survey/${SURVEY_ID}`

  it('免登录提交，答卷入库且不记 IP', async () => {
    const t = env()
    const r = await t.call('POST', path, undefined, { consent: true, answers: fullAnswers() })
    expect(r.status).toBe(200)
    const rows = t.store.listSurveyResponses(SURVEY_ID)
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0])).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
  })

  it('校验失败返回 400 和原因', async () => {
    const t = env()
    const r = await t.call('POST', path, undefined, { consent: true, answers: { q01: '院长' } })
    expect(r.status).toBe(400)
    expect(r.data.code).toBe('bad_option')
    expect(t.store.surveyStats(SURVEY_ID).count).toBe(0)
  })

  it('蜜罐字段被填写时假装成功、不入库', async () => {
    const t = env()
    const r = await t.call('POST', path, undefined, { consent: true, answers: fullAnswers(), website: 'spam.example' })
    expect(r.status).toBe(200)
    expect(t.store.surveyStats(SURVEY_ID).count).toBe(0)
  })

  it('同一来源一小时最多提交 10 份', async () => {
    const t = env()
    for (let i = 0; i < 10; i++) expect((await t.call('POST', path, undefined, { consent: true, answers: fullAnswers() })).status).toBe(200)
    expect((await t.call('POST', path, undefined, { consent: true, answers: fullAnswers() })).status).toBe(429)
  })

  it('只有平台管理员能看统计和导出', async () => {
    const t = env()
    await t.call('POST', path, undefined, { consent: true, answers: fullAnswers() })
    const admin = await t.register('admin')
    const user = await t.register('user1')
    expect((await t.call('GET', `/api/admin/surveys/${SURVEY_ID}`)).status).toBe(401)
    expect((await t.call('GET', `/api/admin/surveys/${SURVEY_ID}/export`, user.token)).status).toBe(403)
    const st = await t.call('GET', `/api/admin/surveys/${SURVEY_ID}`, admin.token)
    expect(st.data.count).toBe(1)
    const csv = await t.call('GET', `/api/admin/surveys/${SURVEY_ID}/export?format=csv`, admin.token)
    expect(csv.data.filename).toMatch(/\.csv$/)
    expect(csv.data.content).toContain('q04:Word')
    const json = await t.call('GET', `/api/admin/surveys/${SURVEY_ID}/export?format=json`, admin.token)
    expect(JSON.parse(json.data.content).responses).toHaveLength(1)
    expect(t.store.listAudit({ action: 'survey.export' })).toHaveLength(2)
  })
})
