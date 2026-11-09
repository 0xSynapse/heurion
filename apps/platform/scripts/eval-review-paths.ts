/** 深度审稿评测的目录约定与清单读取（下载、检查、运行、打分脚本共用，避免脚本之间互相导入） */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Split = 'dev' | 'test'

export interface ReviewPaper {
  id: string
  pmid: string | null
  title: string
  journal: string
  year: number
  design: string
  split: Split
  language: 'en' | 'zh'
  license: string
  url: string
  /** 已被规则或提示词针对过（如 paper/benchmarks 的 7 篇）：只能做开发集，不能报告效果 */
  contaminated?: boolean
}

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
/** 仓库内（进 git）：清单、植入定义、人工判定 */
export const EVAL_DIR = fileURLToPath(new URL('../eval/deep-review/', import.meta.url))
export const MANIFEST = join(EVAL_DIR, 'manifest.json')
export const INJECTIONS_DIR = join(EVAL_DIR, 'injections')
/** 仓库外（不进 git）：全文 XML、转换后的稿件、运行结果 */
export const DATA_DIR = join(ROOT, 'data', 'eval', 'deep-review')
export const XML_DIR = join(DATA_DIR, 'xml')
export const MD_DIR = join(DATA_DIR, 'md')
/** 导入质量评测（eval-import.ts）：同版本 PDF + JATS（取自 PMC 开放获取数据集）、生成的 docx、每次运行结果；不进 git */
export const IMPORT_DATA_DIR = join(ROOT, 'data', 'eval', 'import')
/** 导入质量基线（进 git）：每种导入路径的汇总指标，eval:import 与之对比防退步 */
export const IMPORT_BASELINE = fileURLToPath(new URL('../eval/import/baseline.json', import.meta.url))

export const readManifest = (): ReviewPaper[] => (existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : [])
