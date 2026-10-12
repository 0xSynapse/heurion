import type { AssetRow, DatasetRow, DocRow, Store, StudyRole } from '../store/db.ts'

/**
 * 访问判定（研究团队协作，docs/design/TEAM.md）：文档、数据集、图片资产「谁能看、谁能改」只在这里决定，接口 / MCP / 协同 / 服务层都调它。
 *
 * - 归入研究的文档与数据集属于研究：按研究成员角色访问（owner / editor 可写，viewer 只读）；创建者被移出研究后也就看不到了。
 * - 不在研究里的：只有主人（创建者）能访问，与之前一样。患者的病例报告仍只属于主人（患者数据另有诊疗组规则）。
 * - 研究负责人对研究里的文档、数据集相当于主人（可删除）；editor 能改不能删别人的。
 * - 图片资产：主人；或被我能读的研究文档引用；或是用我能读的数据集画的分析图。
 */

export type Level = 'read' | 'write' | 'manage'
export type ResourceRole = StudyRole

const RANK: Record<ResourceRole, number> = {
  viewer: 1,
  auditor: 1,
  cra: 1, // 临床监查员 (CRA)：只读监查与数据核对 (SDV)
  editor: 2,
  crc: 2, // 临床协调员 (CRC)：入组、访视记录、eCRF 录入
  sub_i: 2, // 共同研究者 (Sub-I)：方案编写、病人评估、数据分析
  statistician: 2, // 生物统计师：统计分析计划、Table 1、生存分析、绘图
  data_manager: 2, // 数据管理员 (DM)：数据清洗、字典管理、逻辑核查
  radiologist: 2, // 放射/影像评估员：影像阅片、RECIST 1.1 靶病灶测量、3D 分割
  owner: 3, // 主要研究者 (PI / 负责人)：研究全局管理、成员增删、终审发布
}
const NEED: Record<Level, number> = { read: 1, write: 2, manage: 3 }

/** 角色是否够某一级访问 */
export const allows = (role: ResourceRole | null | undefined, level: Level): boolean => !!role && (RANK[role] ?? 0) >= NEED[level]

interface Context { kind?: string; study_id?: string }
const contextOf = (doc: Pick<DocRow, 'context'>): Context | null => {
  if (!doc.context) return null
  try { return JSON.parse(doc.context) as Context } catch { return null }
}

export class Access {
  /** 图片资产可读的缓存：用户 → 研究文档里引用的资产 id（30 秒） */
  private assetCache = new Map<string, { at: number; ids: Set<string> }>()
  /** 读文档正文（找引用的资产）；index.ts 接上 Documents。 */
  docText: ((docId: string) => string) | null = null

  constructor(private readonly store: Store) {}

  /** 我在研究里的角色（不是成员为 null） */
  studyRole(user: string, studyId: string): ResourceRole | null {
    return this.store.studyRole(studyId, user)
  }

  /** 文档归在哪个研究（不在研究里为 null） */
  studyOfDoc(doc: Pick<DocRow, 'context'>): string | null {
    const ctx = contextOf(doc)
    return ctx?.kind === 'study' && ctx.study_id ? ctx.study_id : null
  }

  /** 我对文档的角色；回收站里的文档只有主人能看到（恢复 / 彻底删除） */
  docRole(user: string, doc: DocRow | undefined): ResourceRole | null {
    if (!doc) return null
    const study = this.studyOfDoc(doc)
    if (study && !doc.deleted_at) return this.studyRole(user, study)
    return doc.owner === user ? 'owner' : null
  }

  /** 我对数据集的角色 */
  datasetRole(user: string, ds: DatasetRow | undefined): ResourceRole | null {
    if (!ds) return null
    const item = this.store.studyOf('dataset', ds.id)
    if (item) return this.studyRole(user, item.study_id)
    return ds.owner === user ? 'owner' : null
  }

  canDoc(user: string, doc: DocRow | undefined, level: Level): boolean { return allows(this.docRole(user, doc), level) }
  canDataset(user: string, ds: DatasetRow | undefined, level: Level): boolean { return allows(this.datasetRole(user, ds), level) }

  /** 研究里的文档 / 数据集的「删除」：研究负责人，或创建者本人（仍有编辑权时） */
  canDelete(user: string, row: { owner: string }, role: ResourceRole | null): boolean {
    return role === 'owner' || (allows(role, 'write') && row.owner === user)
  }

  /** 图片资产可读：主人；用我能读的数据集画的分析图；被我能读的研究文档引用 */
  canAsset(user: string, asset: Pick<AssetRow, 'id' | 'owner'> | undefined): boolean {
    if (!asset) return false
    if (asset.owner === user) return true
    const prov = this.store.getAssetProvenance(asset.id)
    if (prov?.datasets.some(d => this.canDataset(user, this.store.getDataset(d.id), 'read'))) return true
    return this.referencedAssets(user).has(asset.id)
  }

  /** 我参与的研究里，文档正文引用到的资产 id（研究成员之间看得到彼此插入的图） */
  private referencedAssets(user: string): Set<string> {
    const hit = this.assetCache.get(user)
    if (hit && Date.now() - hit.at < 30_000) return hit.ids
    const ids = new Set<string>()
    if (this.docText) {
      for (const st of this.store.listStudies(user)) {
        for (const item of this.store.studyItems(st.id)) {
          if (item.kind !== 'doc') continue
          let text = ''
          try { text = this.docText(item.ref_id) } catch { continue }
          for (const m of text.matchAll(/"asset_id":"(a[0-9a-f]{15})"/g)) ids.add(m[1]!)
        }
      }
    }
    this.assetCache.set(user, { at: Date.now(), ids })
    return ids
  }

  /** 研究内容变化（归入 / 移出、成员变动）时清缓存 */
  invalidate(): void { this.assetCache.clear() }
}
