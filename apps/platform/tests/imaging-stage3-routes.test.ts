import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken } from '../src/auth/token.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'
import { TurnService } from '../src/turns/service.ts'

function setupApp(pacsEnabled = false) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-st3-')), tenants, new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const uPi = store.createUser({ username: 'pi_doc', display_name: 'PI 主任', password_hash: 'x', tenant: { id: hosp.id, role: 'admin' } }).id
  const uIt = store.createUser({ username: 'it_admin', display_name: '信息科工程师', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id

  const accounts = new Accounts(store, { secret: 'test-secret', devMode: false, devToken: 'dev-tok', devUser: uPi })
  const app = buildApi({
    docs,
    ops: new OpService(docs),
    turns: new TurnService(docs, {} as HarnessPool, new TurnRegistry()),
    postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'st3-'))),
    accounts,
    devMode: false,
    devUser: uPi,
    patients,
    pacsConfig: pacsEnabled
      ? {
          enabled: true,
          webhookSecret: 'orthanc-sec-123',
          allowedAeTitles: ['PACS_MAIN', 'CT_ER_01'],
          allowedRemoteIps: ['10.20.30.40'],
        }
      : { enabled: false, webhookSecret: 'orthanc-sec-123' },
  })
  const tok = (u: string) => `Bearer ${issueToken('test-secret', { u, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: store.getUser(u)!.token_version })}`
  return { app, store, uPi, uIt, tok }
}

describe('Stage 3 HTTP Routes & T3.8 PACS Auto-Forwarding Integration', () => {
  it('mounts T3.6 Curation & Release Gate HTTP routes with dual-role approval and rollback', async () => {
    const { app, uPi, uIt, tok } = setupApp()
    const piToken = tok(uPi)
    const itToken = tok(uIt)

    // 1. Register v2.1.0 baseline and activate it
    const baseEval = await app.request('/api/imaging/releases/evaluate', {
      method: 'POST',
      headers: { authorization: piToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'lung_nodule',
        model_id: 'lung_nodule_pipeline',
        version: 'v2.1.0',
        weights_sha256: '1'.repeat(64),
        eval_metrics: {
          overall: { sensitivity: 0.95, fp_per_scan: 0.85, mean_dice: 0.82 },
          by_size: { lt_6mm: { sensitivity: 0.90, dice: 0.78 }, '6_to_8mm': { sensitivity: 0.95, dice: 0.83 }, gt_8mm: { sensitivity: 0.98, dice: 0.86 } },
          by_density: { solid: { sensitivity: 0.96, dice: 0.85 }, subsolid: { sensitivity: 0.93, dice: 0.80 } },
        },
      }),
    })
    expect(baseEval.status).toBe(201)
    const baseRel = await baseEval.json() as { id: string }
    await app.request(`/api/imaging/releases/${baseRel.id}/approve`, {
      method: 'POST',
      headers: { authorization: piToken, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'pi', note: '基线版本确认' }),
    })
    await app.request(`/api/imaging/releases/${baseRel.id}/approve`, {
      method: 'POST',
      headers: { authorization: itToken, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'it_admin', note: '基线镜像核验' }),
    })
    await app.request(`/api/imaging/releases/${baseRel.id}/promote`, {
      method: 'POST',
      headers: { authorization: piToken },
    })

    // 2. Register v2.2.0 candidate and run non-inferiority gate
    const evalRes = await app.request('/api/imaging/releases/evaluate', {
      method: 'POST',
      headers: { authorization: piToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'lung_nodule',
        model_id: 'lung_nodule_pipeline',
        version: 'v2.2.0',
        weights_sha256: '2'.repeat(64),
        eval_metrics: {
          overall: { sensitivity: 0.965, fp_per_scan: 0.72, mean_dice: 0.85 },
          by_size: { lt_6mm: { sensitivity: 0.92, dice: 0.80 }, '6_to_8mm': { sensitivity: 0.96, dice: 0.85 }, gt_8mm: { sensitivity: 0.99, dice: 0.88 } },
          by_density: { solid: { sensitivity: 0.97, dice: 0.86 }, subsolid: { sensitivity: 0.95, dice: 0.83 } },
        },
      }),
    })
    expect(evalRes.status).toBe(201)
    const cand = await evalRes.json() as { id: string; gate_passed: boolean }
    expect(cand.gate_passed).toBe(true)

    // PI 审批 + 信息科审批
    const app1 = await app.request(`/api/imaging/releases/${cand.id}/approve`, {
      method: 'POST',
      headers: { authorization: piToken, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'pi', note: '敏感度与假阳性均改善' }),
    })
    expect(app1.status).toBe(200)

    const app2 = await app.request(`/api/imaging/releases/${cand.id}/approve`, {
      method: 'POST',
      headers: { authorization: itToken, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'it_admin', note: '镜像签名核验通过' }),
    })
    expect(app2.status).toBe(200)
    expect(((await app2.json()) as { status: string }).status).toBe('approved')

    // 上线激活与回滚至上一版本 v2.1.0
    const prom = await app.request(`/api/imaging/releases/${cand.id}/promote`, {
      method: 'POST',
      headers: { authorization: piToken },
    })
    expect(prom.status).toBe(200)
    expect(((await prom.json()) as { status: string }).status).toBe('active')

    const roll = await app.request(`/api/imaging/releases/${cand.id}/rollback`, {
      method: 'POST',
      headers: { authorization: itToken, 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'lung_nodule', model_id: 'lung_nodule_pipeline', reason: '演练一键回滚机制' }),
    })
    expect(roll.status).toBe(200)
    const rollBody = await roll.json() as { rolled_back: { version: string; status: string }; restored: { version: string; status: string } }
    expect(rollBody.rolled_back.version).toBe('v2.2.0')
    expect(rollBody.rolled_back.status).toBe('rolled_back')
    expect(rollBody.restored.version).toBe('v2.1.0')
    expect(rollBody.restored.status).toBe('active')
  })

  it('mounts T3.7 MRMC Study and T3.2-T3.4 CT Extensions HTTP routes', async () => {
    const { app, uPi, uIt, tok } = setupApp()
    const token = tok(uPi)

    // MRMC Study create + tasks
    const createRes = await app.request('/api/imaging/mrmc/studies', {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '肺结节 MRMC 试验',
        washout_days: 28,
        readers: [uPi, uIt],
        cases: [
          {
            case_id: 'C1',
            ground_truth_lesions: [{ id: 'G1', center_lps_mm: [10, 10, 10], mean_diameter_mm: 7.5 }],
            ai_candidates: [{ id: 'A1', center_lps_mm: [10.2, 10, 10], mean_diameter_mm: 7.4, score: 0.91 }],
          },
          {
            case_id: 'C2',
            ground_truth_lesions: [],
            ai_candidates: [],
          },
        ],
      }),
    })
    expect(createRes.status).toBe(201)
    const study = await createRes.json() as { protocol_id: string }

    const tasksRes = await app.request(`/api/imaging/mrmc/studies/${study.protocol_id}/tasks`, {
      headers: { authorization: token },
    })
    expect(tasksRes.status).toBe(200)
    const tasksBody = await tasksRes.json() as { done: boolean; assignment: { case_id: string } | null }
    expect(tasksBody.done).toBe(false)
    expect(tasksBody.assignment).not.toBeNull()

    // CT Extensions: Pneumonia CTSS + Rib Fractures + Head ICH + Critical Alert Confirmation
    const pneuRes = await app.request('/api/imaging/ct-extensions/pneumonia-ctss', {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json' },
      body: JSON.stringify({
        lobes: [{ lobe: 'RUL', lobe_volume_ml: 1000, ggo_volume_ml: 40, consolidation_volume_ml: 0 }],
      }),
    })
    expect(pneuRes.status).toBe(200)
    expect(((await pneuRes.json()) as { total_ctss: number }).total_ctss).toBe(1)

    const ribRes = await app.request('/api/imaging/ct-extensions/rib-fractures', {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json' },
      body: JSON.stringify({
        candidates: [
          { side: 'left', rib_number: 6, anatomical_arc: 'lateral', cortical_gap_mm: 1.5, callus_formation_ratio: 0.02, displacement_mm: 2.2 },
        ],
      }),
    })
    expect(ribRes.status).toBe(200)
    expect(((await ribRes.json()) as { counts: { acute: number } }).counts.acute).toBe(1)

    const ichRes = await app.request('/api/imaging/ct-extensions/head-ich', {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json' },
      body: JSON.stringify({
        hemorrhages: [
          { subtype: 'intraparenchymal', hemisphere: 'right', location_zh: '右侧丘脑', volume_ml: 22.0, mean_hu: 66.0 },
        ],
        midline_shift_mm: 5.8,
        priority: 'stat',
      }),
    })
    expect(ichRes.status).toBe(200)
    const ichSummary = await ichRes.json() as { p90_sla_seconds: number; critical_alert_pending_confirmation: boolean }
    expect(ichSummary.p90_sla_seconds).toBe(60)
    expect(ichSummary.critical_alert_pending_confirmation).toBe(true)

    const confirmRes = await app.request('/api/imaging/ct-extensions/head-ich/confirm-critical', {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: ichSummary }),
    })
    expect(confirmRes.status).toBe(200)
    expect(((await confirmRes.json()) as { critical_alert_confirmed_by: string }).critical_alert_confirmed_by).toBe(uPi)
  })

  it('enforces T3.8 PACS C-STORE webhook security and routes Chest/Head CT series automatically', async () => {
    // 1. Default disabled
    const disabledApp = setupApp(false).app
    const offRes = await disabledApp.request('/api/imaging/pacs/webhook', {
      method: 'POST',
      headers: { 'x-orthanc-webhook-secret': 'orthanc-sec-123', 'content-type': 'application/json' },
      body: JSON.stringify({ study_instance_uid: '1.2.3', series_instance_uid: '1.2.3.1', modality: 'CT', num_instances: 200, calling_aet: 'PACS_MAIN', remote_ip: '10.20.30.40' }),
    })
    expect(offRes.status).toBe(403)

    // 2. Enabled with allowlist
    const { app, uPi, tok } = setupApp(true)
    const token = tok(uPi)

    // Reject unauthorized AET
    const badAet = await app.request('/api/imaging/pacs/webhook', {
      method: 'POST',
      headers: { 'x-orthanc-webhook-secret': 'orthanc-sec-123', 'content-type': 'application/json' },
      body: JSON.stringify({ study_instance_uid: '1.2.3', series_instance_uid: '1.2.3.1', modality: 'CT', num_instances: 200, calling_aet: 'UNKNOWN_SCU', remote_ip: '10.20.30.40' }),
    })
    expect(badAet.status).toBe(403)
    expect(((await badAet.json()) as { code: string }).code).toBe('aet_not_allowed')

    // Skip localizer series
    const locRes = await app.request('/api/imaging/pacs/webhook', {
      method: 'POST',
      headers: { 'x-orthanc-webhook-secret': 'orthanc-sec-123', 'content-type': 'application/json' },
      body: JSON.stringify({
        study_instance_uid: '1.2.840.1001',
        series_instance_uid: '1.2.840.1001.1',
        modality: 'CT',
        series_description: 'Scout Localizer',
        num_instances: 2,
        calling_aet: 'PACS_MAIN',
        remote_ip: '10.20.30.40',
      }),
    })
    expect(locRes.status).toBe(200)
    const locBody = await locRes.json() as { accepted: boolean; skip_reason: string }
    expect(locBody.accepted).toBe(false)
    expect(locBody.skip_reason).toContain('定位像')

    // Route thin-slice Chest CT (with rib trauma keyword) -> lung_nodule + rib_fracture_ct
    const chestRes = await app.request('/api/imaging/pacs/webhook', {
      method: 'POST',
      headers: { 'x-orthanc-webhook-secret': 'orthanc-sec-123', 'content-type': 'application/json' },
      body: JSON.stringify({
        study_instance_uid: '1.2.840.1001',
        series_instance_uid: '1.2.840.1001.2',
        modality: 'CT',
        body_part_examined: 'CHEST',
        series_description: 'Chest HRCT 1.25mm Rib Trauma',
        slice_thickness_mm: 1.25,
        num_instances: 260,
        calling_aet: 'PACS_MAIN',
        remote_ip: '10.20.30.40',
      }),
    })
    expect(chestRes.status).toBe(201)
    const chestBody = await chestRes.json() as { accepted: boolean; routed_tasks: string[]; queue_priority: string }
    expect(chestBody.accepted).toBe(true)
    expect(chestBody.routed_tasks).toEqual(['lung_nodule', 'rib_fracture_ct'])
    expect(chestBody.queue_priority).toBe('urgent')

    // Route Emergency Head CT -> head_ich_ct with stat priority & P90 <= 60s SLA
    const headRes = await app.request('/api/imaging/pacs/webhook', {
      method: 'POST',
      headers: { 'x-orthanc-webhook-secret': 'orthanc-sec-123', 'content-type': 'application/json' },
      body: JSON.stringify({
        study_instance_uid: '1.2.840.1002',
        series_instance_uid: '1.2.840.1002.1',
        modality: 'CT',
        body_part_examined: 'HEAD',
        study_description: '急诊卒中绿色通道头颅平扫 CT',
        slice_thickness_mm: 2.5,
        num_instances: 64,
        calling_aet: 'CT_ER_01',
        remote_ip: '10.20.30.40',
      }),
    })
    expect(headRes.status).toBe(201)
    const headBody = await headRes.json() as { accepted: boolean; routed_tasks: string[]; queue_priority: string; p90_sla_seconds: number }
    expect(headBody.accepted).toBe(true)
    expect(headBody.routed_tasks).toEqual(['head_ich_ct'])
    expect(headBody.queue_priority).toBe('stat')
    expect(headBody.p90_sla_seconds).toBe(60)

    // Verify events log
    const eventsRes = await app.request('/api/imaging/pacs/events', {
      headers: { authorization: token },
    })
    expect(eventsRes.status).toBe(200)
    const eventsBody = await eventsRes.json() as { events: unknown[] }
    expect(eventsBody.events).toHaveLength(3)
  })
})
