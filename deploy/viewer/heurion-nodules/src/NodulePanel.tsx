import React, { useCallback, useEffect, useState } from 'react';

/** 平台 /api/viewer/lesions 返回的病灶（字段见 apps/platform/src/imaging/studies.ts LesionRow） */
interface Lesion {
  id: string;
  label: string | null;
  location: string | null;
  source: 'ai' | 'manual';
  status: 'proposed' | 'confirmed' | 'rejected';
  reject_reason: string | null;
  series_uid: string | null;
  /** 分割轮廓：所在 DICOM SEG 的 SeriesInstanceUID 与 segment 编号（分割失败的结节为 null） */
  seg: { series_uid: string; segment_number: number } | null;
  version: number;
  metrics: {
    mean_diameter_mm?: number | null;
    long_axis_mm?: number | null;
    short_axis_mm?: number | null;
    volume_mm3?: number | null;
    mean_hu?: number | null;
    nodule_type?: string | null;
    detection_score?: number | null;
    segmentation?: string | null;
    key_slice_sop_instance_uid?: string | null;
    center_lps_mm?: number[] | null;
    warnings?: string[];
  };
}

const LOBE: Record<string, string> = { RUL: '右肺上叶', RML: '右肺中叶', RLL: '右肺下叶', LUL: '左肺上叶', LLL: '左肺下叶' };
const TYPE: Record<string, string> = { solid: '实性', part_solid: '部分实性', pure_ggo: '纯磨玻璃' };
const STATUS: Record<string, { text: string; color: string }> = {
  proposed: { text: '待确认', color: '#f5a623' },
  confirmed: { text: '已确认', color: '#3fb950' },
  rejected: { text: '已否决', color: '#8b949e' },
};
/** 肺窗（W1500 / L-600），与报告的测量习惯一致 */
const LUNG_WINDOW = { windowWidth: 1500, windowCenter: -600 };

const fmt = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits));
const studyUidFromUrl = () => new URLSearchParams(window.location.search).get('StudyInstanceUIDs')?.split(',')[0] ?? null;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export default function NodulePanel({ servicesManager, commandsManager }) {
  const studyUid = studyUidFromUrl();
  const [lesions, setLesions] = useState<Lesion[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!studyUid) return setError('地址里没有检查编号');
    try {
      const r = await fetch(`/api/viewer/lesions?StudyInstanceUID=${encodeURIComponent(studyUid)}`, { credentials: 'same-origin' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setLesions(body.lesions ?? []);
      setReasons(body.reject_reasons ?? []);
      setError(null);
    } catch (e) {
      setError(`读取结节失败：${(e as Error).message}`);
    }
  }, [studyUid]);

  useEffect(() => { void load(); }, [load]);

  /**
   * 有分割轮廓时：把 SEG 叠加到当前视口（只画描边、不填充，不遮挡结节内部纹理），跳到该 segment 中心并高亮。
   * 返回是否已按 SEG 跳转；SEG 还没加载好等情况返回 false，由调用方按关键层跳转。
   */
  const jumpBySeg = useCallback(async (l: Lesion, viewportId: string): Promise<boolean> => {
    if (!l.seg) return false;
    const { displaySetService, segmentationService } = servicesManager.services;
    const segDs = displaySetService.getActiveDisplaySets().find(d => d.Modality === 'SEG' && d.SeriesInstanceUID === l.seg!.series_uid);
    if (!segDs) return false;
    const segmentationId = segDs.displaySetInstanceUID;
    // 显式加载 SEG 并叠加到当前视口（hydrateSecondaryDisplaySet 只记下展示方式，CT 已在视口里时不会触发加载；2026-10-26 实测）
    if (!segmentationService.getSegmentation(segmentationId)) await segDs.load({ headers: {} });
    if (!segmentationService.getSegmentation(segmentationId)) return false;
    if (segmentationService.getSegmentationRepresentations(viewportId, { segmentationId }).length === 0) {
      await segmentationService.addSegmentationRepresentation(viewportId, { segmentationId });
    }
    segmentationService.setStyle({ type: 'Labelmap', segmentationId }, { renderFill: false, renderOutline: true, outlineWidth: 2 });
    segmentationService.jumpToSegmentCenter(segmentationId, l.seg.segment_number, viewportId);
    return true;
  }, [servicesManager]);

  /** 跳到结节：有分割轮廓时按 SEG 跳并显示描边；否则把所在序列放进当前视口，按关键层的 SOPInstanceUID 定位。最后切到肺窗 */
  const jump = useCallback(async (l: Lesion) => {
    setSelected(l.id);
    const { viewportGridService, displaySetService, cornerstoneViewportService } = servicesManager.services;
    const viewportId = viewportGridService.getActiveViewportId();
    if (!viewportId) return;
    if (await jumpBySeg(l, viewportId).catch(() => false)) {
      commandsManager.runCommand('setViewportWindowLevel', { viewportId, ...LUNG_WINDOW });
      return;
    }
    const ds = displaySetService.getActiveDisplaySets().find(d => d.SeriesInstanceUID === l.series_uid);
    const current = viewportGridService.getState().viewports.get(viewportId)?.displaySetInstanceUIDs ?? [];
    if (ds && !current.includes(ds.displaySetInstanceUID)) {
      viewportGridService.setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs: [ds.displaySetInstanceUID] });
    }
    const sop = l.metrics.key_slice_sop_instance_uid;
    // 换序列后视口要一点时间装载影像：最多等 3 秒
    for (let i = 0; i < 30; i++) {
      const vp = cornerstoneViewportService.getCornerstoneViewport(viewportId);
      const ids: string[] = vp?.getImageIds?.() ?? [];
      const idx = sop ? ids.findIndex(id => id.includes(`/instances/${sop}/`)) : -1;
      if (idx >= 0) {
        vp.setImageIdIndex(idx);
        break;
      }
      if (vp?.jumpToWorld && l.metrics.center_lps_mm && !ids.length) {
        // 体积视口：按病人坐标跳转
        vp.jumpToWorld(l.metrics.center_lps_mm);
        break;
      }
      await sleep(100);
    }
    commandsManager.runCommand('setViewportWindowLevel', { viewportId, ...LUNG_WINDOW });
  }, [servicesManager, commandsManager, jumpBySeg]);

  const review = useCallback(async (l: Lesion, status: 'confirmed' | 'rejected', reason?: string) => {
    setBusy(l.id);
    try {
      const r = await fetch(`/api/viewer/lesions/${encodeURIComponent(l.id)}/review`, {
        method: 'POST',
        credentials: 'same-origin',
        // 自定义请求头：平台据此拒绝跨站伪造的请求
        headers: { 'Content-Type': 'application/json', 'X-Heurion-Viewer': '1' },
        body: JSON.stringify({ status, reason }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setLesions(ls => ls.map(x => (x.id === l.id ? { ...x, ...body } : x)));
      setRejecting(null);
    } catch (e) {
      setError(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, []);

  const counts = { proposed: 0, confirmed: 0, rejected: 0 };
  lesions.forEach(l => { counts[l.status] = (counts[l.status] ?? 0) + 1; });

  return (
    <div style={{ padding: 8, color: '#e6edf3', fontSize: 13, overflowY: 'auto', height: '100%' }} data-cy="heurion-nodule-panel">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <b>结节</b>
        <span style={{ marginLeft: 8, color: '#8b949e' }}>待确认 {counts.proposed} · 已确认 {counts.confirmed} · 已否决 {counts.rejected}</span>
        <button style={{ marginLeft: 'auto' }} onClick={() => void load()}>刷新</button>
      </div>
      <div style={{ color: '#8b949e', fontSize: 12, marginBottom: 8 }}>AI 检出的结节需医生确认后才进入报告；点一行跳到关键层。</div>
      {error && <div style={{ color: '#f85149', marginBottom: 8 }}>{error}</div>}
      {!error && lesions.length === 0 && <div style={{ color: '#8b949e' }}>这个检查还没有结节结果。</div>}
      {lesions.map(l => {
        const m = l.metrics ?? {};
        const st = STATUS[l.status];
        return (
          <div
            key={l.id}
            data-cy="heurion-nodule"
            onClick={() => void jump(l)}
            style={{ border: `1px solid ${selected === l.id ? '#58a6ff' : '#30363d'}`, borderRadius: 6, padding: 8, marginBottom: 6, cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <b>{l.label ?? '结节'}</b>
              <span style={{ marginLeft: 6 }}>{LOBE[l.location ?? ''] ?? l.location ?? '肺叶未定'}</span>
              <span style={{ marginLeft: 'auto', color: st.color }}>{st.text}</span>
            </div>
            <div style={{ marginTop: 4 }}>
              平均径 {fmt(m.mean_diameter_mm)} mm（长 {fmt(m.long_axis_mm)} × 短 {fmt(m.short_axis_mm)}）· 体积 {fmt(m.volume_mm3, 0)} mm³
            </div>
            <div style={{ color: '#8b949e' }}>
              {TYPE[m.nodule_type ?? ''] ?? '密度未定'} · 平均 CT 值 {fmt(m.mean_hu, 0)} HU
              {l.source === 'ai' ? ` · 检出分数 ${fmt(m.detection_score, 2)}` : ' · 医生补充'}
            </div>
            {m.segmentation === 'failed' && <div style={{ color: '#f5a623' }}>分割失败，测量取检出框径，请核对</div>}
            {(m.warnings ?? []).map(w => <div key={w} style={{ color: '#f5a623' }}>{w}</div>)}
            {l.status === 'rejected' && l.reject_reason && <div style={{ color: '#8b949e' }}>否决原因：{l.reject_reason}</div>}
            <div style={{ marginTop: 6, display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
              {l.status !== 'confirmed' && (
                <button disabled={busy === l.id} onClick={() => void review(l, 'confirmed')}>确认</button>
              )}
              {l.status !== 'rejected' && rejecting?.id !== l.id && (
                <button disabled={busy === l.id} onClick={() => setRejecting({ id: l.id, reason: reasons[0] ?? '其他' })}>否决</button>
              )}
              {rejecting?.id === l.id && (
                <>
                  <select value={rejecting.reason} onChange={e => setRejecting({ id: l.id, reason: e.target.value })} style={{ color: '#000' }}>
                    {reasons.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button disabled={busy === l.id} onClick={() => void review(l, 'rejected', rejecting.reason)}>确定否决</button>
                  <button onClick={() => setRejecting(null)}>取消</button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
