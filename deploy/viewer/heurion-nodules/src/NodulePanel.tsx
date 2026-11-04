import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FollowupHeader, FollowupLine, useFollowup } from './FollowupInfo';

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
    /** 医生点选 / 修边界用过的提示点（病人坐标）；AI 检出且未修过的没有 */
    prompt_points?: PromptPoint[];
    /** 点选分割后后台补肺叶：pending / done / failed；lobe_note 为说明（如周围没有肺叶体素） */
    lobe_status?: string | null;
    lobe_note?: string | null;
  };
}

interface PromptPoint { lps_mm: number[]; positive: boolean }
/** 检查的审核状态（T2.7，平台 src/imaging/review.ts ReviewSummary） */
interface ReviewSummary {
  state: 'reading' | 'submitted' | 'finalized' | 'amending';
  latest_signoff: { version: number; signed_by_name: string | null; signed_at: string } | null;
}
const REVIEW_TEXT: Record<ReviewSummary['state'], string> = { reading: '初写中', submitted: '初写已提交，待审核', finalized: '已定稿', amending: '定稿后修改中，待再次定稿' };
/** 从患者页审核视图「跳转」打开时，要定位的结节 */
const focusFromUrl = () => new URLSearchParams(window.location.search).get('HeurionLesion');
/** 点选模式：补一个结节；或修某个结节的边界（positive = 补入，否则排除） */
type PickMode = { kind: 'add' } | { kind: 'refine'; lesionId: string; positive: boolean } | null;

const LOBE: Record<string, string> = { RUL: '右肺上叶', RML: '右肺中叶', RLL: '右肺下叶', LUL: '左肺上叶', LLL: '左肺下叶' };
const TYPE: Record<string, string> = { solid: '实性', part_solid: '部分实性', pure_ggo: '纯磨玻璃' };
const STATUS: Record<string, { text: string; color: string }> = {
  proposed: { text: '待确认', color: '#f5a623' },
  confirmed: { text: '已确认', color: '#3fb950' },
  rejected: { text: '已否决', color: '#8b949e' },
};
/** 肺窗（W1500 / L-600），与报告的测量习惯一致 */
const LUNG_WINDOW = { windowWidth: 1500, windowCenter: -600 };

/** 每个结节只突出一条需要医生核对的要点；worker 的完整提示收进「详情」 */
function keyNote(m: Lesion['metrics']): string | null {
  if (m.segmentation === 'failed') return '分割失败，测量取检出框径，请核对';
  if ((m.warnings ?? []).some(w => w.includes('推理区域边界'))) return '分割可能被截断，测值可能偏小，请核对';
  if ((m.warnings ?? []).some(w => w.includes('超过 30 mm'))) return '分割偏大，可能沿血管或胸膜扩散，请核对，必要时加排除点';
  return null;
}

/** cornerstone3D 工具层的单击事件（按下后未拖动即松开），detail.currentPoints.world 为病人坐标（LPS，mm） */
const CLICK_EVENT = 'CORNERSTONE_TOOLS_MOUSE_CLICK';

const fmt = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits));
const allStudyUidsFromUrl = () => (new URLSearchParams(window.location.search).get('StudyInstanceUIDs') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const studyUidFromUrl = () => allStudyUidsFromUrl()[0] ?? null;
const priorStudyUidFromUrl = () => allStudyUidsFromUrl()[1] ?? null;
const isCompareFromUrl = () => new URLSearchParams(window.location.search).get('HeurionCompare') === '1' || allStudyUidsFromUrl().length >= 2;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const LOBE_TEXT = (l: Lesion) => (l.location ? LOBE[l.location] ?? l.location : l.metrics.lobe_status === 'pending' ? '肺叶定位中…' : '肺叶未定');
const isLowConfidenceLesion = (l: Lesion) =>
  l.source === 'ai' && l.status === 'proposed' && typeof l.metrics?.detection_score === 'number' && l.metrics.detection_score < 0.30;

/** 阅片器子域名上的写接口：带 Cookie 与自定义请求头（平台据此拒绝跨站伪造的请求） */
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

export default function NodulePanel({ servicesManager, commandsManager, extensionManager }) {
  const studyUid = studyUidFromUrl();
  const priorStudyUid = priorStudyUidFromUrl();
  const compareMode = isCompareFromUrl();
  const [lesions, setLesions] = useState<Lesion[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<PickMode>(null);
  /** 正在进行的点选分割（显示「分割中…」，期间不接受新的点击） */
  const [working, setWorking] = useState<string | null>(null);
  const prepared = useRef(new Set<string>());
  const comparePrepared = useRef(false);
  const [reviewState, setReviewState] = useState<ReviewSummary | null>(null);
  const [lowOpen, setLowOpen] = useState(false);
  const focused = useRef(false);
  /** 随访对比（T2.4）：与前片的对应与变化 */
  const followup = useFollowup(studyUid);

  /** W3.4 双片并排挂片：URL 含当前与前片两个 StudyInstanceUID 时自动切换 1×2 视口并分别装入当期与前片 CT */
  useEffect(() => {
    if (!compareMode || !studyUid || !priorStudyUid || comparePrepared.current) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (comparePrepared.current || tries > 40) {
        clearInterval(timer);
        return;
      }
      tries += 1;
      const { displaySetService, viewportGridService } = servicesManager.services;
      const allDs = displaySetService.getActiveDisplaySets?.() ?? [];
      const currCt = allDs.find(d => d.StudyInstanceUID === studyUid && d.Modality === 'CT');
      const priorCt = allDs.find(d => d.StudyInstanceUID === priorStudyUid && d.Modality === 'CT');
      if (!currCt || !priorCt) return;
      comparePrepared.current = true;
      clearInterval(timer);
      try {
        commandsManager.runCommand('setViewportGridLayout', { numRows: 1, numCols: 2 });
      } catch {
        // fallback if command is unavailable
      }
      setTimeout(() => {
        try {
          const vps = Array.from(viewportGridService.getState().viewports.keys()) as string[];
          if (vps[0]) {
            viewportGridService.setDisplaySetsForViewport({ viewportId: vps[0], displaySetInstanceUIDs: [currCt.displaySetInstanceUID] });
            commandsManager.runCommand('setViewportWindowLevel', { viewportId: vps[0], ...LUNG_WINDOW });
          }
          if (vps[1]) {
            viewportGridService.setDisplaySetsForViewport({ viewportId: vps[1], displaySetInstanceUIDs: [priorCt.displaySetInstanceUID] });
            commandsManager.runCommand('setViewportWindowLevel', { viewportId: vps[1], ...LUNG_WINDOW });
          }
        } catch {
          // ignore viewport assignment timing errors
        }
      }, 300);
    }, 500);
    return () => clearInterval(timer);
  }, [compareMode, studyUid, priorStudyUid, servicesManager, commandsManager]);

  const load = useCallback(async () => {
    if (!studyUid) return setError('地址里没有检查编号');
    try {
      const r = await fetch(`/api/viewer/lesions?StudyInstanceUID=${encodeURIComponent(studyUid)}`, { credentials: 'same-origin' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setLesions(body.lesions ?? []);
      setReasons(body.reject_reasons ?? []);
      setReviewState(body.review ?? null);
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
      if (compareMode && l.metrics.center_lps_mm) {
        for (const otherId of viewportGridService.getState().viewports.keys()) {
          if (otherId === viewportId) continue;
          const vpOther = cornerstoneViewportService.getCornerstoneViewport(otherId);
          vpOther?.jumpToWorld?.(l.metrics.center_lps_mm);
          commandsManager.runCommand('setViewportWindowLevel', { viewportId: otherId, ...LUNG_WINDOW });
        }
      }
      return;
    }
    const ds = displaySetService.getActiveDisplaySets().find(d => d.SeriesInstanceUID === l.series_uid);
    const current = viewportGridService.getState().viewports.get(viewportId)?.displaySetInstanceUIDs ?? [];
    if (ds && !current.includes(ds.displaySetInstanceUID)) {
      viewportGridService.setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs: [ds.displaySetInstanceUID] });
    }
    const sop = l.metrics.key_slice_sop_instance_uid;
    // 换序列或刚打开阅片器时视口要一点时间装载影像：最多等 15 秒（生产经公网加载比本机慢）
    for (let i = 0; i < 150; i++) {
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
    if (compareMode && l.metrics.center_lps_mm) {
      for (const otherId of viewportGridService.getState().viewports.keys()) {
        if (otherId === viewportId) continue;
        const vpOther = cornerstoneViewportService.getCornerstoneViewport(otherId);
        vpOther?.jumpToWorld?.(l.metrics.center_lps_mm);
        commandsManager.runCommand('setViewportWindowLevel', { viewportId: otherId, ...LUNG_WINDOW });
      }
    }
  }, [servicesManager, commandsManager, jumpBySeg, compareMode]);

  /** 从审核视图「跳转」打开：结节列表到了、视口有了之后定位一次（视口还没就绪时稍后再试） */
  useEffect(() => {
    const id = focusFromUrl();
    if (!id || focused.current) return;
    const l = lesions.find(x => x.id === id);
    if (!l) return;
    if (isLowConfidenceLesion(l)) setLowOpen(true);
    let tries = 0;
    const tick = () => {
      if (focused.current) return;
      if (servicesManager.services.viewportGridService.getActiveViewportId() || tries >= 10) {
        focused.current = true;
        void jump(l);
        return;
      }
      tries += 1;
      setTimeout(tick, 500);
    };
    tick();
  }, [lesions, jump, servicesManager]);

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
      void followup.load();
    } catch (e) {
      setError(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [followup.load]);

  /** 视口里正在显示的 CT 序列（点选分割、预加载用） */
  const ctSeriesOf = useCallback((viewportId: string): string | null => {
    const { viewportGridService, displaySetService } = servicesManager.services;
    const uids: string[] = viewportGridService.getState().viewports.get(viewportId)?.displaySetInstanceUIDs ?? [];
    const ds = uids.map(u => displaySetService.getDisplaySetByUID(u)).find(d => d?.Modality === 'CT');
    return ds?.SeriesInstanceUID ?? null;
  }, [servicesManager]);

  /** 打开面板后把当前 CT 序列预加载到影像服务，第一次点选不必等上传 */
  useEffect(() => {
    if (!studyUid) return;
    const tick = () => {
      const { viewportGridService } = servicesManager.services;
      const vp = viewportGridService.getActiveViewportId();
      const series = vp ? ctSeriesOf(vp) : null;
      if (!series || prepared.current.has(series)) return;
      prepared.current.add(series);
      post('/api/viewer/series/prepare', { study_uid: studyUid, series_uid: series }).catch(() => prepared.current.delete(series));
    };
    const id = setInterval(tick, 2000);
    tick();
    return () => clearInterval(id);
  }, [servicesManager, studyUid, ctSeriesOf]);

  /**
   * 新生成的 SEG（点选 / 修边界后存回影像存储）还不在阅片器里：按序列重新取元数据，等 OHIF 生成它的展示集。
   * OHIF 按检查缓存元数据请求（键为「数据源名:检查 UID」），先清掉缓存再按序列过滤取。
   */
  const ensureSegLoaded = useCallback(async (segUid: string): Promise<boolean> => {
    const { displaySetService } = servicesManager.services;
    const has = () => displaySetService.getActiveDisplaySets().some(d => d.Modality === 'SEG' && d.SeriesInstanceUID === segUid);
    if (has()) return true;
    const ds = extensionManager.getActiveDataSource()[0];
    const name = ds.getConfig?.()?.name;
    const forget = () => { ds.deleteStudyMetadataPromise?.(studyUid); if (name) ds.deleteStudyMetadataPromise?.(`${name}:${studyUid}`); };
    forget();
    await ds.retrieve.series.metadata({ StudyInstanceUID: studyUid, filters: { seriesInstanceUID: [segUid] } });
    forget();
    for (let i = 0; i < 80 && !has(); i++) await sleep(100);
    return has();
  }, [servicesManager, extensionManager, studyUid]);

  /**
   * 换下的旧轮廓：在所有视口里隐藏该 segment（共用的 AI SEG 里其它结节不受影响）。
   * 点选产生的中间轮廓在列表里已没有病灶引用时，平台已把它从影像存储删除：阅片器里也移除，免得左侧序列栏留着打不开的序列。
   * AI 分析的原始 SEG 平台保留（AI 原值的追溯依据），这里只隐藏。
   */
  const hideSegment = useCallback((seg: Lesion['seg'], remaining: Lesion[]) => {
    if (!seg) return;
    const { displaySetService, segmentationService } = servicesManager.services;
    const segDs = displaySetService.getActiveDisplaySets().find(d => d.Modality === 'SEG' && d.SeriesInstanceUID === seg.series_uid);
    if (!segDs) return;
    const id = segDs.displaySetInstanceUID;
    const pointSeg = String(segDs.SeriesDescription ?? '').includes('point prompt');
    if (pointSeg && !remaining.some(x => x.seg?.series_uid === seg.series_uid)) {
      if (segmentationService.getSegmentation(id)) segmentationService.remove(id);
      displaySetService.deleteDisplaySet(id);
      return;
    }
    if (!segmentationService.getSegmentation(id)) return;
    for (const vp of segmentationService.getViewportIdsWithSegmentation(id)) {
      segmentationService.setSegmentVisibility(vp, id, seg.segment_number, false);
    }
  }, [servicesManager]);

  /** 点选（补漏 / 修边界）后：刷新列表，加载新轮廓并跳过去；稍后再刷新两次，取后台补上的肺叶 */
  const afterPick = useCallback(async (l: Lesion, old: Lesion['seg'] = null) => {
    const next = lesions.some(x => x.id === l.id) ? lesions.map(x => (x.id === l.id ? l : x)) : [...lesions, l];
    setLesions(next);
    hideSegment(old, next);
    if (l.seg) await ensureSegLoaded(l.seg.series_uid).catch(() => false);
    await jump(l);
    setTimeout(() => void load(), 3000);
    setTimeout(() => void load(), 8000);
  }, [lesions, hideSegment, ensureSegLoaded, jump, load]);

  /** 点选模式下视口里的一次单击 */
  const onPick = useCallback(async (viewportId: string, world: number[]) => {
    if (!mode || working || !studyUid) return;
    const point = { lps_mm: world.map(v => Math.round(v * 100) / 100), positive: mode.kind === 'add' || mode.positive };
    setWorking(mode.kind === 'add' ? '分割中…' : '重新分割中…');
    setError(null);
    try {
      if (mode.kind === 'add') {
        const series = ctSeriesOf(viewportId);
        if (!series) throw new Error('请在 CT 序列上点选');
        const l: Lesion = await post('/api/viewer/lesions/point', { study_uid: studyUid, series_uid: series, points: [point] });
        setMode(null);
        await afterPick(l);
      } else {
        const before = lesions.find(x => x.id === mode.lesionId);
        const l: Lesion = await post(`/api/viewer/lesions/${encodeURIComponent(mode.lesionId)}/refine`, { points: [point] });
        await afterPick(l, before?.seg ?? null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  }, [mode, working, studyUid, ctSeriesOf, lesions, afterPick]);

  /** 点选模式：在每个视口上监听单击；Esc 退出 */
  useEffect(() => {
    if (!mode) return;
    const { viewportGridService, cornerstoneViewportService } = servicesManager.services;
    const off: Array<() => void> = [];
    for (const viewportId of viewportGridService.getState().viewports.keys()) {
      const el: HTMLElement | undefined = cornerstoneViewportService.getCornerstoneViewport(viewportId)?.element;
      if (!el) continue;
      const handler = (evt: Event) => {
        const world = (evt as CustomEvent).detail?.currentPoints?.world;
        if (world && world.length === 3) void onPick(viewportId, Array.from(world as number[]));
      };
      el.addEventListener(CLICK_EVENT, handler);
      off.push(() => el.removeEventListener(CLICK_EVENT, handler));
    }
    // 捕获阶段监听：OHIF 的快捷键处理会截住 Esc，冒泡阶段收不到（2026-10-26 实测）
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMode(null); };
    window.addEventListener('keydown', esc, true);
    return () => { off.forEach(f => f()); window.removeEventListener('keydown', esc, true); };
  }, [mode, servicesManager, onPick]);

  /** 修边界：撤销上一个点（以其余的点重新分割） */
  const undoPoint = useCallback(async (l: Lesion) => {
    const pts = l.metrics.prompt_points ?? [];
    if (pts.length < 2) return;
    setWorking('重新分割中…');
    try {
      const n: Lesion = await post(`/api/viewer/lesions/${encodeURIComponent(l.id)}/refine`, { points: pts.slice(0, -1), replace: true });
      await afterPick(n, l.seg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  }, [afterPick]);

  /** 撤销医生补充的结节 */
  const withdraw = useCallback(async (l: Lesion) => {
    setBusy(l.id);
    try {
      await post(`/api/viewer/lesions/${encodeURIComponent(l.id)}/withdraw`, {});
      const next = lesions.filter(x => x.id !== l.id);
      hideSegment(l.seg, next);
      setLesions(next);
      if (mode?.kind === 'refine' && mode.lesionId === l.id) setMode(null);
    } catch (e) {
      setError(`撤销失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [lesions, hideSegment, mode]);

  const counts = { proposed: 0, confirmed: 0, rejected: 0 };
  lesions.forEach(l => { counts[l.status] = (counts[l.status] ?? 0) + 1; });
  const primaryLesions = lesions.filter(l => !isLowConfidenceLesion(l));
  const lowConfidenceLesions = lesions.filter(isLowConfidenceLesion);

  const renderLesionCard = (l: Lesion) => {
    const m = l.metrics ?? {};
    const st = STATUS[l.status];
    const details = [...(m.warnings ?? []), ...(m.lobe_note ? [m.lobe_note] : [])];
    return (
      <div
        key={l.id}
        data-cy="heurion-nodule"
        onClick={() => void jump(l)}
        style={{ border: `1px solid ${selected === l.id ? '#58a6ff' : '#30363d'}`, borderRadius: 6, padding: 8, marginBottom: 6, cursor: 'pointer' }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <b>{l.label ?? '结节'}</b>
          <span style={{ marginLeft: 6 }}>{LOBE_TEXT(l)}</span>
          <span style={{ marginLeft: 'auto', color: st.color }}>{st.text}</span>
        </div>
        <div style={{ marginTop: 4 }}>
          平均径 {fmt(m.mean_diameter_mm)} mm（长 {fmt(m.long_axis_mm)} × 短 {fmt(m.short_axis_mm)}）· 体积 {fmt(m.volume_mm3, 0)} mm³
        </div>
        <div style={{ color: '#8b949e' }}>
          {TYPE[m.nodule_type ?? ''] ?? '密度未定'} · 平均 CT 值 {fmt(m.mean_hu, 0)} HU
          {l.source === 'ai' ? ` · 检出分数 ${fmt(m.detection_score, 2)}` : ' · 医生补充'}
        </div>
        {keyNote(m) && <div style={{ color: '#f5a623' }}>{keyNote(m)}</div>}
        {details.length > 0 && (
          <details onClick={e => e.stopPropagation()} style={{ color: '#8b949e', fontSize: 12 }}>
            <summary style={{ cursor: 'pointer' }}>详情（{details.length} 条）</summary>
            {details.map(w => <div key={w}>· {w}</div>)}
          </details>
        )}
        {l.status === 'rejected' && l.reject_reason && <div style={{ color: '#8b949e' }}>否决原因：{l.reject_reason}</div>}
        <FollowupLine f={followup} lesionId={l.id} />
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
          {l.status !== 'rejected' && rejecting?.id !== l.id && !(mode?.kind === 'refine' && mode.lesionId === l.id) && !!(m.center_lps_mm || m.prompt_points?.length) && (
            <button data-cy="heurion-refine" disabled={!!working} onClick={() => { setMode({ kind: 'refine', lesionId: l.id, positive: true }); void jump(l); }}>修正边界</button>
          )}
          {l.source === 'manual' && (
            <button disabled={busy === l.id || !!working} onClick={() => void withdraw(l)}>撤销</button>
          )}
        </div>
        {mode?.kind === 'refine' && mode.lesionId === l.id && (
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
            <button data-cy="heurion-refine-include" style={{ fontWeight: mode.positive ? 'bold' : 'normal' }} onClick={() => setMode({ ...mode, positive: true })}>补入</button>
            <button data-cy="heurion-refine-exclude" style={{ fontWeight: mode.positive ? 'normal' : 'bold' }} onClick={() => setMode({ ...mode, positive: false })}>排除</button>
            <button disabled={!!working || (m.prompt_points?.length ?? 0) < 2} onClick={() => void undoPoint(l)}>撤销上一点</button>
            <button onClick={() => setMode(null)}>完成</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: 8, color: '#e6edf3', fontSize: 13, overflowY: 'auto', height: '100%' }} data-cy="heurion-nodule-panel">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <b>结节</b>
        <span style={{ marginLeft: 8, color: '#8b949e' }}>待确认 {counts.proposed} · 已确认 {counts.confirmed} · 已否决 {counts.rejected}</span>
        <button style={{ marginLeft: 'auto' }} onClick={() => { void load(); void followup.load(); }}>刷新</button>
      </div>
      {reviewState && (
        <div data-cy="heurion-review-state" style={{ fontSize: 12, marginBottom: 6, color: reviewState.state === 'finalized' ? '#3fb950' : reviewState.state === 'amending' ? '#f5a623' : '#8b949e' }}>
          {REVIEW_TEXT[reviewState.state]}
          {reviewState.latest_signoff ? `（第 ${reviewState.latest_signoff.version} 版${reviewState.latest_signoff.signed_by_name ? `，${reviewState.latest_signoff.signed_by_name}` : ''}）` : ''}
          {reviewState.state === 'finalized' ? '；此时修改会生成新的定稿版本，需审核医师再次定稿' : ''}
        </div>
      )}
      <div style={{ color: '#8b949e', fontSize: 12, marginBottom: 8 }}>AI 检出的结节需医生确认后才进入报告；点一行跳到关键层。</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button data-cy="heurion-add-nodule" disabled={!!working} onClick={() => setMode(mode?.kind === 'add' ? null : { kind: 'add' })}>
          {mode?.kind === 'add' ? '取消点选' : '点选添加结节'}
        </button>
      </div>
      {(mode || working) && (
        <div data-cy="heurion-pick-hint" style={{ background: '#1f6feb33', border: '1px solid #1f6feb', borderRadius: 6, padding: 6, marginBottom: 8 }}>
          {working ?? (mode!.kind === 'add'
            ? '在影像上点击漏掉的结节（点在结节内部）。Esc 取消'
            : `在影像上点击：${mode!.positive ? '补入（属于结节的部分）' : '排除（不属于结节的部分）'}。Esc 结束`)}
        </div>
      )}
      {error && <div style={{ color: '#f85149', marginBottom: 8 }}>{error}</div>}
      <FollowupHeader f={followup} compareMode={compareMode} />
      {!error && lesions.length === 0 && <div style={{ color: '#8b949e' }}>这个检查还没有结节结果。</div>}
      {primaryLesions.map(renderLesionCard)}
      {lowConfidenceLesions.length > 0 && (
        <details
          data-cy="heurion-low-conf-nodules"
          open={lowOpen || lowConfidenceLesions.some(l => l.id === selected || (mode?.kind === 'refine' && mode.lesionId === l.id))}
          onToggle={e => setLowOpen((e.currentTarget as HTMLDetailsElement).open)}
          style={{ marginTop: 8, borderTop: '1px dashed #30363d', paddingTop: 6 }}
        >
          <summary style={{ cursor: 'pointer', color: '#8b949e', fontSize: 12, marginBottom: 6 }}>
            低置信度候选（{lowConfidenceLesions.length} 个，检出分数 &lt; 0.30，点击展开核对）
          </summary>
          {lowConfidenceLesions.map(renderLesionCard)}
        </details>
      )}
    </div>
  );
}
