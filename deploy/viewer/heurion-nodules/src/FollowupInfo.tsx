import React, { useCallback, useEffect, useState } from 'react';

/**
 * 随访对比（PRD T2.4 / W3）在结节面板里的显示：每个结节与前片的对应、变化分类、Δ平均径、Δ体积、倍增时间、
 * 「在误差范围内」；面板顶部显示前片日期、配准质量、前片里消失的结节，并可重新匹配。
 * 医生可拆开对应或改对应到前片的另一个结节（平台接口 /api/viewer/followup*，与确认 / 否决相同的 Cookie 与请求头要求）。
 * 字段见 apps/platform/src/imaging/followup.ts FollowupView。两期并排显示（W3.4）本次不做，只给出前片对应结节的信息。
 */

export interface FollowupBrief { id: string; label: string | null; location: string | null; mean_diameter_mm: number | null; volume_mm3: number | null }
export interface FollowupItem {
  link_id: string | null;
  lesion_id: string | null;
  prior_lesion_id: string | null;
  lesion: FollowupBrief | null;
  prior_lesion: FollowupBrief | null;
  change: 'new' | 'disappeared' | 'enlarged' | 'shrunk' | 'stable' | null;
  source: 'ai' | 'manual' | null;
  metrics: {
    within_error: boolean;
    basis: 'volume' | 'diameter' | null;
    delta_mean_diameter_mm: number | null;
    delta_volume_mm3: number | null;
    delta_volume_pct: number | null;
    vdt_days: number | null;
    vdt_note: string | null;
  } | null;
  match: { distance_mm: number | null; ambiguous: boolean } | null;
  needs_review: boolean;
  notes: string[];
}
export interface FollowupView {
  prior: { study_id: string; study_date: string | null; interval_days: number | null } | null;
  run: { status: string; reason: string | null; error: string | null; summary: { warnings?: string[]; notes?: string[] } | null } | null;
  registration: { quality: 'fine' | 'coarse' | 'none'; reliable: boolean; notes?: string[] } | null;
  tolerance: { volume_pct: number; mean_diameter_mm: number };
  items: FollowupItem[];
}

const CHANGE: Record<string, { text: string; color: string }> = {
  new: { text: '新发', color: '#f85149' },
  disappeared: { text: '消失', color: '#8b949e' },
  enlarged: { text: '增大', color: '#f85149' },
  shrunk: { text: '缩小', color: '#3fb950' },
  stable: { text: '稳定', color: '#3fb950' },
};
const QUALITY: Record<string, string> = { fine: '配准可靠', coarse: '粗配准，对应关系请核对', none: '未能配准，对应关系不可靠，请逐一核对' };
const signed = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`);

async function post(path: string, body: unknown) {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Heurion-Viewer': '1' },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
  return json;
}

/** 读随访对比；重新匹配后轮询几次等结果 */
export function useFollowup(studyUid: string | null) {
  const [view, setView] = useState<FollowupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!studyUid) return;
    try {
      const r = await fetch(`/api/viewer/followup?StudyInstanceUID=${encodeURIComponent(studyUid)}`, { credentials: 'same-origin' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setView(body);
      setError(null);
    } catch (e) {
      setError(`读取随访对比失败：${(e as Error).message}`);
    }
  }, [studyUid]);
  useEffect(() => { void load(); }, [load]);
  const act = useCallback(async (fn: () => Promise<FollowupView | null>) => {
    try {
      const v = await fn();
      if (v) setView(v);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const rematch = useCallback(() => act(async () => {
    await post('/api/viewer/followup/rematch', { study_uid: studyUid });
    for (const ms of [800, 2000, 5000]) setTimeout(() => void load(), ms);
    return null;
  }), [act, load, studyUid]);
  const unlink = useCallback((linkId: string) => act(() => post(`/api/viewer/followup/links/${encodeURIComponent(linkId)}/unlink`, {})), [act]);
  const relink = useCallback((lesionId: string, priorLesionId: string | null) =>
    act(() => post('/api/viewer/followup/links', { study_uid: studyUid, lesion_id: lesionId, prior_lesion_id: priorLesionId })), [act, studyUid]);
  return { view, error, load, rematch, unlink, relink };
}

/** 面板顶部：前片、配准质量、提示、消失的结节、重新匹配 */
export function FollowupHeader({ f }: { f: ReturnType<typeof useFollowup> }) {
  const v = f.view;
  if (!v) return f.error ? <div style={{ color: '#f85149', marginBottom: 8 }}>{f.error}</div> : null;
  const gone = v.items.filter(i => !i.lesion_id && i.prior_lesion);
  const running = v.run && (v.run.status === 'queued' || v.run.status === 'running');
  const warnings = [...(v.registration?.notes ?? []), ...(v.run?.summary?.warnings ?? v.run?.summary?.notes ?? [])];
  return (
    <div data-cy="heurion-followup" style={{ border: '1px solid #30363d', borderRadius: 6, padding: 6, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <b>随访对比</b>
        <span style={{ marginLeft: 8, color: '#8b949e' }}>
          {v.prior ? `前片 ${v.prior.study_date ?? '日期未知'}（间隔 ${v.prior.interval_days ?? '—'} 天）` : running ? '匹配中…' : v.run?.reason ?? v.run?.error ?? '还没有前片对比'}
        </span>
        <button style={{ marginLeft: 'auto' }} disabled={!!running} onClick={() => void f.rematch()}>重新匹配</button>
      </div>
      {v.registration && <div style={{ color: v.registration.reliable ? '#8b949e' : '#f5a623' }}>{QUALITY[v.registration.quality] ?? v.registration.quality}</div>}
      {v.run?.status === 'failed' && <div style={{ color: '#f85149' }}>匹配失败：{v.run.error}</div>}
      {v.run?.status === 'interrupted' && <div style={{ color: '#f5a623' }}>上次匹配被中断，请重新匹配</div>}
      {v.prior && (
        <div style={{ color: '#8b949e', fontSize: 12 }}>
          误差范围：体积 ±{v.tolerance.volume_pct}%、平均径 ±{v.tolerance.mean_diameter_mm} mm 以内视为稳定
        </div>
      )}
      {warnings.length > 0 && (
        <details style={{ color: '#8b949e', fontSize: 12 }}>
          <summary style={{ cursor: 'pointer' }}>说明（{warnings.length} 条）</summary>
          {warnings.map(w => <div key={w}>· {w}</div>)}
        </details>
      )}
      {gone.map(i => (
        <div key={i.prior_lesion_id!} style={{ marginTop: 4 }}>
          <span style={{ color: i.change ? CHANGE[i.change].color : '#8b949e' }}>{i.change ? CHANGE[i.change].text : '未对比'}</span>
          {' '}前片{i.prior_lesion!.label ?? '结节'}（{i.prior_lesion!.location ?? '肺叶未定'}，{i.prior_lesion!.mean_diameter_mm ?? '—'} mm）
          {i.source === 'manual' && <span style={{ color: '#8b949e' }}> · 医生判定</span>}
          {i.needs_review && <span style={{ color: '#f5a623' }}> · 请核对</span>}
          {i.notes.map(n => <div key={n} style={{ color: '#8b949e', fontSize: 12 }}>{n}</div>)}
        </div>
      ))}
    </div>
  );
}

/** 结节卡片里的一行：与前片的对应与变化；可拆开、改对应 */
export function FollowupLine({ f, lesionId }: { f: ReturnType<typeof useFollowup>; lesionId: string }) {
  const [editing, setEditing] = useState(false);
  const v = f.view;
  if (!v?.prior) return null;
  const it = v.items.find(i => i.lesion_id === lesionId);
  if (!it) return null;
  const m = it.metrics;
  const priors = v.items.filter(i => i.prior_lesion).map(i => i.prior_lesion!);
  const c = it.change ? CHANGE[it.change] : null;
  return (
    <div data-cy="heurion-followup-line" style={{ marginTop: 4 }} onClick={e => e.stopPropagation()}>
      <span style={{ color: c?.color ?? '#8b949e' }}>{c?.text ?? '未对比'}</span>
      {it.prior_lesion && <span> · 前片{it.prior_lesion.label ?? '结节'}（{it.prior_lesion.mean_diameter_mm ?? '—'} mm）</span>}
      {m && (
        <span>
          {' '}· Δ平均径 {signed(m.delta_mean_diameter_mm)} mm · Δ体积 {signed(m.delta_volume_mm3, 0)} mm³（{signed(m.delta_volume_pct)}%）
          {m.within_error && <span style={{ color: '#8b949e' }}> · 在误差范围内</span>}
          {m.vdt_days !== null && <span> · 倍增时间 {m.vdt_days} 天</span>}
        </span>
      )}
      {it.source === 'manual' && <span style={{ color: '#8b949e' }}> · 医生对应</span>}
      {it.needs_review && <span style={{ color: '#f5a623' }}> · 请核对</span>}
      {[...(m?.vdt_note && m.vdt_days !== null ? [m.vdt_note] : []), ...it.notes].map(n => <div key={n} style={{ color: '#8b949e', fontSize: 12 }}>{n}</div>)}
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        {it.link_id && it.lesion_id && it.prior_lesion_id && <button onClick={() => void f.unlink(it.link_id!)}>拆开</button>}
        {!editing && <button onClick={() => setEditing(true)}>改对应</button>}
        {editing && (
          <select
            defaultValue={it.prior_lesion_id ?? ''}
            style={{ color: '#000' }}
            onChange={e => { setEditing(false); void f.relink(lesionId, e.target.value || null); }}
          >
            <option value="">前片没有（新发）</option>
            {priors.map(p => <option key={p.id} value={p.id}>前片{p.label ?? '结节'}（{p.location ?? '肺叶未定'}，{p.mean_diameter_mm ?? '—'} mm）</option>)}
          </select>
        )}
      </div>
    </div>
  );
}
