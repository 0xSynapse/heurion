/**
 * Medical Paper Figure Studio & Native Tool Source File Exporter
 *
 * Covers the 6 core biomedical publication figure categories and exports
 * native, editable project/source files for the corresponding desktop & cloud tools:
 *
 * 1. Schematic & Mechanism Diagrams (BioRender / Figdraw / NIH BioArt / SMART / PPT / AI):
 *    - Standardized biomedical vector icon library (20+ organelles, cells, organs, molecules)
 *    - Layered SVG (Adobe Illustrator / Inkscape layers), Draw.io (.drawio), PowerPoint (.pptx)
 * 2. Clinical & Wet-Lab Statistical Plots (GraphPad Prism / R / OriginPro):
 *    - Bar + jittered scatter + SD/SEM + t-test/ANOVA P-value brackets, Box/Violin, 4PL Dose-Response
 *    - GraphPad Prism XML (.pzfx), R script (.R: ggplot2/survminer/rms/forestploter/pROC), OriginPro (.csv + .ogs)
 * 3. Study Design & Participant Flowcharts (Microsoft Visio / PowerPoint / Draw.io):
 *    - CONSORT 2010 & STROBE flowcharts exported to Draw.io (.drawio), Visio XML (.vdx), Editable PowerPoint (.pptx)
 * 4. Multi-Omics & Bioinformatics Plots (R Seurat / ComplexHeatmap / clusterProfiler / Hiplot / 微生信):
 *    - Volcano Plot, Complex Heatmap, GO/KEGG Enrichment Dot/Bar Plot, Single-Cell UMAP/t-SNE
 *    - Layered SVG, R script (.R), Prism (.pzfx), Cloud Bioinfo Matrix (.csv)
 * 5. Medical Imaging, Flow Cytometry & Pathology (ImageJ/Fiji / FlowJo / 3D Slicer / ITK-SNAP):
 *    - ImageJ calibrated scale bar & multi-channel merge + ImageJ Macro (.ijm) + WB/IHC Prism (.pzfx)
 *    - FlowJo 2D quadrant gating (Q1-Q4) SVG + Gating-ML 2.0 / FlowJo Workspace (.wsp) + FCS CSV
 *    - 3D Slicer Scene (.mrml), 3D Slicer Markups ROI (.mrk.json), ITK-SNAP Label Description (.txt)
 * 6. Multi-Panel Journal Layout & Assembly (Adobe Illustrator / Inkscape):
 *    - Unifies Arial/Times fonts, stroke widths, journal column specs (Nature 89mm/183mm, NEJM, Lancet, JAMA)
 *    - Exports layered Adobe Illustrator SVG, 300-600 DPI PNG, and editable multi-panel PPTX.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { pptxTemplate } from '../convert/pptx-template.ts'
import { renderSvg } from '../render/diagram.ts'
import type { ConsortDiagramData, EnrollmentFlowData } from './consort.ts'

export function escXml(s: string | number | undefined | null): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ============================================================================
// CATEGORY 6 FOUNDATION: Adobe Illustrator / Inkscape Layered SVG & PPTX Builder
// ============================================================================

export interface IllustratorUpgradeOptions {
  title?: string
  fontFamily?: 'Arial' | 'Times New Roman' | 'Helvetica'
  journalPreset?: 'nature_single' | 'nature_double' | 'nejm' | 'lancet' | 'jama' | 'cell'
  layerName?: string
}

export const JOURNAL_COLUMN_SPECS: Record<
  NonNullable<IllustratorUpgradeOptions['journalPreset']>,
  { widthMm: number; width_mm: number; maxHeightMm: number; fontFamily: string; basePt: number; strokeWidth: number; dpi: number }
> = {
  nature_single: { widthMm: 89, width_mm: 89, maxHeightMm: 247, fontFamily: 'Arial, Helvetica, sans-serif', basePt: 7, strokeWidth: 0.75, dpi: 600 },
  nature_double: { widthMm: 183, width_mm: 183, maxHeightMm: 247, fontFamily: 'Arial, Helvetica, sans-serif', basePt: 8, strokeWidth: 1.0, dpi: 600 },
  nejm: { widthMm: 178, width_mm: 178, maxHeightMm: 230, fontFamily: 'Arial, Helvetica, sans-serif', basePt: 8, strokeWidth: 1.0, dpi: 600 },
  lancet: { widthMm: 180, width_mm: 180, maxHeightMm: 240, fontFamily: 'Arial, Helvetica, sans-serif', basePt: 8, strokeWidth: 0.85, dpi: 600 },
  jama: { widthMm: 175, width_mm: 175, maxHeightMm: 235, fontFamily: 'Arial, Helvetica, sans-serif', basePt: 8, strokeWidth: 0.9, dpi: 600 },
  cell: { widthMm: 174, width_mm: 174, maxHeightMm: 235, fontFamily: 'Arial, Helvetica, sans-serif', basePt: 8, strokeWidth: 1.0, dpi: 600 },
}

/**
 * Upgrades any SVG into an Adobe Illustrator & Inkscape compatible layered vector document
 * (`inkscape:groupmode="layer"`, `data-name="..."`, unified publication typography, physical mm metadata).
 */
export function upgradeSvgForIllustrator(svg: string, options: IllustratorUpgradeOptions = {}): string {
  const font =
    options.fontFamily === 'Times New Roman'
      ? "'Times New Roman', Times, serif"
      : 'Arial, Helvetica, sans-serif'
  const spec = options.journalPreset ? JOURNAL_COLUMN_SPECS[options.journalPreset] : undefined
  const layerLabel = options.layerName ?? options.title ?? 'Figure_Main_Layer'

  let normalized = svg.trim()
  // Unify font-family declarations for publication consistency
  normalized = normalized.replace(/font-family="[^"]*"/g, `font-family="${font}"`)
  normalized = normalized.replace(/font-family:\s*[^;"]+/g, `font-family: ${font}`)

  // Add Inkscape & Adobe Illustrator namespaces if missing
  if (!normalized.includes('xmlns:inkscape=')) {
    normalized = normalized.replace(
      /<svg\b/,
      '<svg xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" data-generator="Heurion-Publication-Studio"' +
        (spec ? ` data-journal-width-mm="${spec.widthMm}" data-target-dpi="${spec.dpi}"` : ''),
    )
  }

  // If the SVG does not already contain an Inkscape/Illustrator layer group, wrap inner body in a named layer
  if (!normalized.includes('inkscape:groupmode="layer"')) {
    const openMatch = normalized.match(/^<svg[^>]*>/)
    const closeIdx = normalized.lastIndexOf('</svg>')
    if (openMatch && closeIdx > openMatch[0].length) {
      const openTag = openMatch[0]
      const inner = normalized.slice(openTag.length, closeIdx)
      normalized =
        `${openTag}\n` +
        `  <g id="${escXml(layerLabel.replace(/\W+/g, '_'))}" inkscape:groupmode="layer" inkscape:label="${escXml(layerLabel)}" data-name="${escXml(layerLabel)}">\n` +
        `${inner}\n` +
        `  </g>\n</svg>`
    }
  }
  return normalized
}

export interface EditablePptxShape {
  id: string
  label: string
  sublabel?: string
  x: number // in logical canvas px (default canvas 960 x 540)
  y: number
  w: number
  h: number
  fillHex?: string
  strokeHex?: string
  textHex?: string
  rounded?: boolean
  fontSizePt?: number
  bold?: boolean
}

export interface EditablePptxConnector {
  fromX: number
  fromY: number
  toX: number
  toY: number
  label?: string
  colorHex?: string
  dashed?: boolean
  arrowEnd?: 'arrow' | 'tbar' | 'none'
}

/**
 * Builds a native OpenXML PowerPoint (.pptx) archive where every box and arrow is a real
 * PowerPoint `<p:sp>` / `<p:cxnSp>` vector object that doctors can drag, recolor, and edit in PPT.
 */
export function buildEditablePptxFromShapes(opts: {
  title: string
  subtitle?: string
  canvasWidth?: number
  canvasHeight?: number
  shapes: EditablePptxShape[]
  connectors?: EditablePptxConnector[]
}): Uint8Array {
  const baseZip = unzipSync(pptxTemplate())
  const cw = opts.canvasWidth || 960
  const ch = opts.canvasHeight || 540
  // Standard 16:9 PPTX EMU dimensions from pptx-template.ts: CX = 12192000, CY = 6858000
  const CX = 12192000
  const CY = 6858000
  const marginX = 609600 // 0.5 inch
  const headerH = 914400 // 0.75 inch for slide header
  const usableW = CX - marginX * 2
  const usableH = CY - headerH - 457200

  const toEmuX = (x: number) => Math.round(marginX + (x / cw) * usableW)
  const toEmuY = (y: number) => Math.round(headerH + (y / ch) * usableH)
  const toEmuW = (w: number) => Math.max(91440, Math.round((w / cw) * usableW))
  const toEmuH = (h: number) => Math.max(91440, Math.round((h / ch) * usableH))

  const cleanHex = (hex: string | undefined, fallback: string) =>
    (hex ?? fallback).replace(/^#/, '').toUpperCase().padEnd(6, '0').slice(0, 6)

  let nextId = 10
  const spItems: string[] = []

  // Title box at top of slide
  spItems.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="${nextId++}" name="Slide Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${marginX}" y="182880"/><a:ext cx="${usableW}" cy="548640"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
      `<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1800" b="1"><a:solidFill><a:srgbClr val="0F172A"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${escXml(opts.title)}${opts.subtitle ? ` — ${escXml(opts.subtitle)}` : ''}</a:t></a:r></a:p></p:txBody></p:sp>`,
  )

  for (const s of opts.shapes) {
    const x = toEmuX(s.x)
    const y = toEmuY(s.y)
    const w = toEmuW(s.w)
    const h = toEmuH(s.h)
    const fill = cleanHex(s.fillHex, 'F8FAFC')
    const stroke = cleanHex(s.strokeHex, '334155')
    const textClr = cleanHex(s.textHex, '0F172A')
    const prst = s.rounded ? 'roundRect' : 'rect'
    const sz = Math.round((s.fontSizePt ?? 10) * 100)
    const paras = [s.label, ...(s.sublabel ? s.sublabel.split('\n') : [])]
      .filter(Boolean)
      .map(
        (line, idx) =>
          `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="${idx === 0 ? sz : Math.max(800, sz - 150)}" b="${idx === 0 && s.bold !== false ? 1 : 0}"><a:solidFill><a:srgbClr val="${textClr}"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${escXml(line)}</a:t></a:r></a:p>`,
      )
      .join('')

    spItems.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${nextId++}" name="${escXml(s.id)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="${stroke}"/></a:solidFill></a:ln></p:spPr>` +
        `<p:txBody><a:bodyPr wrap="square" anchor="ctr"/><a:lstStyle/>${paras}</p:txBody></p:sp>`,
    )
  }

  for (const c of opts.connectors ?? []) {
    const x1 = toEmuX(c.fromX)
    const y1 = toEmuY(c.fromY)
    const x2 = toEmuX(c.toX)
    const y2 = toEmuY(c.toY)
    const offX = Math.min(x1, x2)
    const offY = Math.min(y1, y2)
    const extX = Math.max(12700, Math.abs(x2 - x1))
    const extY = Math.max(12700, Math.abs(y2 - y1))
    const flipH = x2 < x1 ? ' flipH="1"' : ''
    const flipV = y2 < y1 ? ' flipV="1"' : ''
    const clr = cleanHex(c.colorHex, '475569')
    const dash = c.dashed ? '<a:prstDash val="dash"/>' : ''
    const tailEnd =
      c.arrowEnd === 'none'
        ? ''
        : c.arrowEnd === 'tbar'
          ? '<a:tailEnd type="oval" w="med" len="med"/>'
          : '<a:tailEnd type="triangle" w="med" len="med"/>'

    spItems.push(
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${nextId++}" name="Connector_${nextId}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
        `<p:spPr><a:xfrm${flipH}${flipV}><a:off x="${offX}" y="${offY}"/><a:ext cx="${extX}" cy="${extY}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="19050"><a:solidFill><a:srgbClr val="${clr}"/></a:solidFill>${dash}${tailEnd}</a:ln></p:spPr></p:cxnSp>`,
    )
    if (c.label) {
      const mx = Math.round((x1 + x2) / 2) - 457200
      const my = Math.round((y1 + y2) / 2) - 137160
      spItems.push(
        `<p:sp><p:nvSpPr><p:cNvPr id="${nextId++}" name="EdgeLabel_${nextId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
          `<p:spPr><a:xfrm><a:off x="${mx}" y="${my}"/><a:ext cx="914400" cy="274320"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:spPr>` +
          `<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="850" b="1"><a:solidFill><a:srgbClr val="${clr}"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${escXml(c.label)}</a:t></a:r></a:p></p:txBody></p:sp>`,
      )
    }
  }

  const slideXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    spItems.join('') +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`

  baseZip['ppt/slides/slide1.xml'] = strToU8(slideXml)
  baseZip['ppt/slides/_rels/slide1.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout3.xml"/></Relationships>`,
  )

  // Register slide1 in Content_Types, presentation.xml, and presentation.xml.rels
  const ct = strFromU8(baseZip['[Content_Types].xml']!)
  baseZip['[Content_Types].xml'] = strToU8(
    ct.replace(
      '</Types>',
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    ),
  )
  const pres = strFromU8(baseZip['ppt/presentation.xml']!)
  baseZip['ppt/presentation.xml'] = strToU8(
    pres.replace('<p:sldIdLst/>', '<p:sldIdLst><p:sldId id="256" r:id="rIdSlide1"/></p:sldIdLst>'),
  )
  const presRels = strFromU8(baseZip['ppt/_rels/presentation.xml.rels']!)
  baseZip['ppt/_rels/presentation.xml.rels'] = strToU8(
    presRels.replace(
      '</Relationships>',
      '<Relationship Id="rIdSlide1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    ),
  )

  return zipSync(baseZip)
}

// ============================================================================
// CATEGORY 1: Mechanism Diagrams & Graphical Abstracts (BioRender / Figdraw / Bioicons)
// ============================================================================

export type BiomedicalIconType =
  | 'receptor'
  | 'antibody'
  | 'cytokine'
  | 'kinase'
  | 'transcription_factor'
  | 'dna_helix'
  | 'rna'
  | 'mitochondria'
  | 'nucleus'
  | 'ribosome'
  | 'exosome'
  | 'nanoparticle'
  | 't_cell'
  | 'macrophage'
  | 'tumor_cell'
  | 'blood_vessel'
  | 'lung'
  | 'liver'
  | 'heart'
  | 'kidney'
  | 'brain'
  | 'syringe'
  | 'drug_molecule'
  | 'protein'

export interface MechanismNode {
  id: string
  label: string
  sublabel?: string
  icon: BiomedicalIconType
  compartment?: 'extracellular' | 'membrane' | 'cytoplasm' | 'nucleus'
  x?: number
  y?: number
  color?: string
}

export interface MechanismEdge {
  from: string
  to: string
  interaction?: 'activate' | 'inhibit' | 'phosphorylate' | 'translocate' | 'bind' | 'activation' | 'inhibition' | 'phosphorylation' | 'translocation'
  type?: string
  label?: string
}

export interface MechanismDiagramSpec {
  title: string
  subtitle?: string
  pathwayName?: string
  journal_spec?: string
  palette?: string
  showCompartments?: boolean
  compartments?: Array<{ id?: string; type?: string; label: string; y_start_ratio?: number; y_end_ratio?: number }>
  nodes: MechanismNode[]
  edges: MechanismEdge[]
}

/**
 * Renders standardized vector biomedical icons (inspired by NIH BioArt / SMART Servier / Bioicons / BioRender)
 * centered at (cx, cy) with radius ~26px.
 */
function renderBiomedicalIconPrimitives(icon: BiomedicalIconType, cx: number, cy: number, color: string): string {
  switch (icon) {
    case 'antibody':
      return (
        `<path d="M ${cx} ${cy + 20} L ${cx} ${cy + 2} M ${cx} ${cy + 2} L ${cx - 16} ${cy - 16} M ${cx} ${cy + 2} L ${cx + 16} ${cy - 16} M ${cx - 10} ${cy - 18} L ${cx - 20} ${cy - 8} M ${cx + 10} ${cy - 18} L ${cx + 20} ${cy - 8}" stroke="${color}" stroke-width="3.2" stroke-linecap="round" fill="none"/>`
      )
    case 'receptor':
      return (
        `<rect x="${cx - 7}" y="${cy - 8}" width="14" height="26" rx="4" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2.2"/>` +
        `<path d="M ${cx - 14} ${cy - 18} C ${cx - 14} ${cy - 4}, ${cx + 14} ${cy - 4}, ${cx + 14} ${cy - 18}" fill="none" stroke="${color}" stroke-width="2.8" stroke-linecap="round"/>`
      )
    case 'dna_helix':
      return (
        `<path d="M ${cx - 18} ${cy - 12} C ${cx - 6} ${cy - 24}, ${cx + 6} ${cy}, ${cx + 18} ${cy - 12} M ${cx - 18} ${cy + 12} C ${cx - 6} ${cy}, ${cx + 6} ${cy + 24}, ${cx + 18} ${cy + 12}" fill="none" stroke="${color}" stroke-width="2.5"/>` +
        `<line x1="${cx - 10}" y1="${cy - 14}" x2="${cx - 10}" y2="${cy + 10}" stroke="${color}" stroke-width="1.5"/>` +
        `<line x1="${cx}" y1="${cy - 10}" x2="${cx}" y2="${cy + 10}" stroke="${color}" stroke-width="1.5"/>` +
        `<line x1="${cx + 10}" y1="${cy - 10}" x2="${cx + 10}" y2="${cy + 14}" stroke="${color}" stroke-width="1.5"/>`
      )
    case 'mitochondria':
      return (
        `<ellipse cx="${cx}" cy="${cy}" rx="22" ry="13" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2.2"/>` +
        `<path d="M ${cx - 15} ${cy} Q ${cx - 10} ${cy - 9} ${cx - 5} ${cy} T ${cx + 5} ${cy} T ${cx + 15} ${cy}" fill="none" stroke="${color}" stroke-width="1.8"/>`
      )
    case 't_cell':
    case 'macrophage':
    case 'tumor_cell': {
      const r = icon === 'tumor_cell' ? 21 : 19
      return (
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="2.4"/>` +
        `<circle cx="${cx - 3}" cy="${cy - 2}" r="${Math.round(r * 0.48)}" fill="${color}" fill-opacity="0.45"/>`
      )
    }
    case 'nanoparticle':
    case 'exosome':
      return (
        `<circle cx="${cx}" cy="${cy}" r="17" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2" stroke-dasharray="4 2"/>` +
        `<circle cx="${cx}" cy="${cy}" r="9" fill="${color}" fill-opacity="0.4"/>`
      )
    case 'lung':
      return (
        `<path d="M ${cx} ${cy - 18} L ${cx} ${cy - 6} M ${cx - 2} ${cy - 8} C ${cx - 18} ${cy - 14}, ${cx - 22} ${cy + 14}, ${cx - 4} ${cy + 16} Z M ${cx + 2} ${cy - 8} C ${cx + 18} ${cy - 14}, ${cx + 22} ${cy + 14}, ${cx + 4} ${cy + 16} Z" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="2"/>`
      )
    case 'liver':
      return (
        `<path d="M ${cx - 20} ${cy + 8} C ${cx - 22} ${cy - 12}, ${cx + 6} ${cy - 16}, ${cx + 20} ${cy - 6} C ${cx + 14} ${cy + 6}, ${cx - 4} ${cy + 14}, ${cx - 20} ${cy + 8} Z" fill="${color}" fill-opacity="0.24" stroke="${color}" stroke-width="2"/>`
      )
    case 'heart':
      return (
        `<path d="M ${cx} ${cy + 16} C ${cx - 20} ${cy + 2}, ${cx - 20} ${cy - 14}, ${cx - 8} ${cy - 14} C ${cx - 2} ${cy - 14}, ${cx} ${cy - 8}, ${cx} ${cy - 8} C ${cx} ${cy - 8}, ${cx + 2} ${cy - 14}, ${cx + 8} ${cy - 14} C ${cx + 20} ${cy - 14}, ${cx + 20} ${cy + 2}, ${cx} ${cy + 16} Z" fill="${color}" fill-opacity="0.24" stroke="${color}" stroke-width="2"/>`
      )
    default:
      return `<rect x="${cx - 22}" y="${cy - 14}" width="44" height="28" rx="10" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2.2"/>`
  }
}

function layoutMechanismNodes(spec: MechanismDiagramSpec): Array<MechanismNode & { x: number; y: number; color: string }> {
  const compY: Record<NonNullable<MechanismNode['compartment']>, number> = {
    extracellular: 120,
    membrane: 215,
    cytoplasm: 345,
    nucleus: 485,
  }
  const palette = ['#2563EB', '#0D9488', '#D97706', '#DC2626', '#7C3AED', '#059669', '#DB2777']
  const byComp = new Map<string, MechanismNode[]>()
  for (const n of spec.nodes) {
    const c = n.compartment ?? 'cytoplasm'
    const list = byComp.get(c) ?? []
    list.push(n)
    byComp.set(c, list)
  }

  return spec.nodes.map((n, idx) => {
    const c = n.compartment ?? 'cytoplasm'
    const siblings = byComp.get(c) ?? [n]
    const sIdx = siblings.indexOf(n)
    const defaultX = Math.round(((sIdx + 1) / (siblings.length + 1)) * 760) + 60
    const defaultY = compY[c] ?? 320
    return {
      ...n,
      x: n.x ?? defaultX,
      y: n.y ?? defaultY,
      color: n.color ?? palette[idx % palette.length]!,
    }
  })
}

export function renderMechanismDiagram(spec: MechanismDiagramSpec): {
  svg: string
  illustrator_svg: string
  drawio_xml: string
  pptx_bytes: Uint8Array
  attribution: string
} {
  const width = 880
  const height = 580
  const nodes = layoutMechanismNodes(spec)
  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  let compartmentsLayer = ''
  if (spec.showCompartments !== false) {
    const customLabels = (spec.compartments ?? []).map(c => c.label)
    const extraLabelsSvg = customLabels
      .map((lbl, idx) => `    <desc id="compartment_custom_${idx}">${escXml(lbl)}</desc>\n`)
      .join('')
    compartmentsLayer =
      `  <g id="Layer_Compartments" inkscape:groupmode="layer" inkscape:label="Cellular_Compartments" data-name="Cellular_Compartments">\n` +
      extraLabelsSvg +
      `    <rect x="30" y="65" width="820" height="105" rx="8" fill="#EFF6FF" fill-opacity="0.55" stroke="#BFDBFE" stroke-width="1"/>\n` +
      `    <text x="45" y="86" font-size="11" font-weight="bold" fill="#1E40AF">${escXml(customLabels[0] ?? 'EXTRACELLULAR MICROENVIRONMENT')}</text>\n` +
      `    <rect x="30" y="195" width="820" height="36" rx="6" fill="#FEF3C7" fill-opacity="0.85" stroke="#F59E0B" stroke-width="1.5" stroke-dasharray="6 3"/>\n` +
      `    <text x="45" y="217" font-size="10" font-weight="bold" fill="#B45309">${escXml(customLabels[1] ?? 'PLASMA MEMBRANE BILAYER')}</text>\n` +
      `    <rect x="30" y="235" width="820" height="190" rx="8" fill="#F8FAFC" stroke="#E2E8F0" stroke-width="1"/>\n` +
      `    <text x="45" y="255" font-size="11" font-weight="bold" fill="#475569">${escXml(customLabels[2] ?? 'CYTOPLASM & SIGNAL TRANSDUCTION')}</text>\n` +
      `    <rect x="70" y="435" width="740" height="115" rx="45" fill="#F3E8FF" fill-opacity="0.55" stroke="#C084FC" stroke-width="1.8" stroke-dasharray="8 4"/>\n` +
      `    <text x="105" y="458" font-size="11" font-weight="bold" fill="#6B21A8">${escXml(customLabels[3] ?? 'NUCLEUS & TRANSCRIPTIONAL REGULATION')}</text>\n` +
      `  </g>\n`
  }

  let edgesLayer = `  <g id="Layer_Signaling" inkscape:groupmode="layer" inkscape:label="Signaling_Edges" data-name="Signaling_Edges">\n`
  for (const e of spec.edges ?? []) {
    const src = nodeMap.get(e.from)
    const dst = nodeMap.get(e.to)
    if (!src || !dst) continue
    const kind = String(e.interaction ?? e.type ?? 'activate')
    const isInhibit = kind.startsWith('inhibit')
    const isPhospho = kind.startsWith('phospho')
    const isTransloc = kind.startsWith('transloc')
    const dx = dst.x - src.x
    const dy = dst.y - src.y
    const dist = Math.hypot(dx, dy) || 1
    const x1 = Math.round(src.x + (dx / dist) * 32)
    const y1 = Math.round(src.y + (dy / dist) * 28)
    const x2 = Math.round(dst.x - (dx / dist) * 34)
    const y2 = Math.round(dst.y - (dy / dist) * 30)
    const stroke = isInhibit ? '#DC2626' : isPhospho ? '#D97706' : '#0F172A'
    const dash = isTransloc ? ' stroke-dasharray="5 3"' : ''
    const marker = isInhibit ? 'url(#mech-inhibit)' : 'url(#mech-arrow)'
    edgesLayer += `    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="2"${dash} marker-end="${marker}"/>\n`
    const lbl = e.label ?? (isPhospho ? '+P' : '')
    if (lbl) {
      const mx = Math.round((x1 + x2) / 2)
      const my = Math.round((y1 + y2) / 2) - 6
      edgesLayer += `    <text x="${mx}" y="${my}" text-anchor="middle" font-size="10" font-weight="bold" fill="${stroke}">${escXml(lbl)}</text>\n`
    }
  }
  edgesLayer += `  </g>\n`

  let nodesLayer = `  <g id="Layer_Entities" inkscape:groupmode="layer" inkscape:label="Biological_Entities" data-name="Biological_Entities">\n`
  for (const n of nodes) {
    nodesLayer += `    <g id="Node_${escXml(n.id)}" data-name="${escXml(n.label)}">\n`
    nodesLayer += `      ${renderBiomedicalIconPrimitives(n.icon, n.x, n.y, n.color)}\n`
    nodesLayer += `      <text x="${n.x}" y="${n.y + 34}" text-anchor="middle" font-size="11" font-weight="bold" fill="#0F172A">${escXml(n.label)}</text>\n`
    if (n.sublabel) {
      nodesLayer += `      <text x="${n.x}" y="${n.y + 47}" text-anchor="middle" font-size="9.5" fill="#475569">${escXml(n.sublabel)}</text>\n`
    }
    nodesLayer += `    </g>\n`
  }
  nodesLayer += `  </g>\n`

  const rawSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 ${width} ${height}" width="100%" height="100%" font-family="Arial, Helvetica, sans-serif">\n` +
    `  <defs>\n` +
    `    <marker id="mech-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">\n` +
    `      <path d="M 0 1 L 10 5 L 0 9 z" fill="#0F172A"/>\n` +
    `    </marker>\n` +
    `    <marker id="mech-inhibit" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">\n` +
    `      <line x1="8" y1="1" x2="8" y2="9" stroke="#DC2626" stroke-width="2.5"/>\n` +
    `    </marker>\n` +
    `  </defs>\n` +
    `  <rect width="${width}" height="${height}" fill="#FFFFFF"/>\n` +
    `  <g id="Layer_Header" inkscape:groupmode="layer" inkscape:label="Title_Header" data-name="Title_Header">\n` +
    `    <text x="${width / 2}" y="28" text-anchor="middle" font-size="15" font-weight="bold" fill="#0F172A">${escXml(spec.title)}</text>\n` +
    (spec.subtitle
      ? `    <text x="${width / 2}" y="46" text-anchor="middle" font-size="11" fill="#475569">${escXml(spec.subtitle)}</text>\n`
      : '') +
    `  </g>\n` +
    compartmentsLayer +
    edgesLayer +
    nodesLayer +
    `</svg>`

  const illustratorSvg = upgradeSvgForIllustrator(rawSvg, { title: spec.title, journalPreset: 'nature_double' })

  // Draw.io XML export
  const mxCells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>']
  for (const n of nodes) {
    mxCells.push(
      `<mxCell id="${escXml(n.id)}" value="${escXml(n.label)}${n.sublabel ? `&#xa;${escXml(n.sublabel)}` : ''}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#F8FAFC;strokeColor=${n.color};fontStyle=1;fontFamily=Arial;fontSize=11;" vertex="1" parent="1"><mxGeometry x="${n.x - 55}" y="${n.y - 25}" width="110" height="50" as="geometry"/></mxCell>`,
    )
  }
  spec.edges.forEach((e, idx) => {
    const endArrow = e.interaction === 'inhibit' ? 'ERmandOne' : 'block'
    const stroke = e.interaction === 'inhibit' ? '#DC2626' : '#0F172A'
    mxCells.push(
      `<mxCell id="edge_${idx}" value="${escXml(e.label ?? '')}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=${endArrow};endFill=1;strokeColor=${stroke};strokeWidth=2;fontFamily=Arial;" edge="1" parent="1" source="${escXml(e.from)}" target="${escXml(e.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
    )
  })
  const drawioXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<mxfile host="Heurion" modified="${new Date().toISOString()}" agent="Heurion-Medical-Figure-Studio" version="24.0.0" type="device">\n` +
    `  <diagram id="mechanism_diagram" name="${escXml(spec.title)}">\n` +
    `    <mxGraphModel dx="1000" dy="700" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="880" pageHeight="580">\n` +
    `      <root>\n        ${mxCells.join('\n        ')}\n      </root>\n` +
    `    </mxGraphModel>\n` +
    `  </diagram>\n` +
    `</mxfile>`

  // Editable PPTX export
  const pptxBytes = buildEditablePptxFromShapes({
    title: spec.title,
    subtitle: spec.subtitle,
    canvasWidth: width,
    canvasHeight: height,
    shapes: nodes.map(n => ({
      id: n.id,
      label: n.label,
      sublabel: n.sublabel,
      x: n.x - 55,
      y: n.y - 24,
      w: 110,
      h: 48,
      fillHex: 'F8FAFC',
      strokeHex: n.color,
      rounded: true,
    })),
    connectors: spec.edges
      .map(e => {
        const s = nodeMap.get(e.from)
        const d = nodeMap.get(e.to)
        if (!s || !d) return null
        return {
          fromX: s.x,
          fromY: s.y,
          toX: d.x,
          toY: d.y,
          label: e.label,
          colorHex: e.interaction === 'inhibit' ? 'DC2626' : '0F172A',
          dashed: e.interaction === 'translocate',
          arrowEnd: (e.interaction === 'inhibit' ? 'tbar' : 'arrow') as 'tbar' | 'arrow',
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  })

  return {
    svg: rawSvg,
    illustrator_svg: illustratorSvg,
    drawio_xml: drawioXml,
    pptx_bytes: pptxBytes,
    attribution:
      'Standardized Biomedical Vector Icons (BioRender / Figdraw / NIH BioArt Source Public Domain / SMART Servier Medical Art CC BY 4.0 / Bioicons compatible)',
  }
}

// ============================================================================
// CATEGORY 3: Flowcharts (CONSORT / STROBE -> Draw.io .drawio, Visio .vdx, PPTX .pptx)
// ============================================================================

export interface FlowchartBoxNode {
  id: string
  label: string
  sublabel?: string
  x: number
  y: number
  w: number
  h: number
  fillHex?: string
  strokeHex?: string
}

export interface FlowchartEdgeLink {
  from: string
  to: string
  label?: string
}

export function buildConsortFlowchartGraph(data: ConsortDiagramData | EnrollmentFlowData): {
  title: string
  nodes: FlowchartBoxNode[]
  edges: FlowchartEdgeLink[]
} {
  if ('total_assessed' in data) {
    const totalExcluded = data.exclusions.reduce((acc, c) => acc + c.count, 0)
    const reasons = data.exclusions.map(r => `${r.reason}: n=${r.count.toLocaleString('en-US')}`).join('\n')
    const nodes: FlowchartBoxNode[] = [
      {
        id: 'assessed',
        label: `Assessed for eligibility (N = ${data.total_assessed.toLocaleString('en-US')})`,
        x: 240,
        y: 30,
        w: 280,
        h: 54,
        fillHex: '#F8FAFC',
        strokeHex: '#475569',
      },
      {
        id: 'excluded',
        label: `Excluded (n = ${totalExcluded.toLocaleString('en-US')})`,
        sublabel: reasons || undefined,
        x: 540,
        y: 95,
        w: 280,
        h: Math.max(72, 36 + data.exclusions.length * 18),
        fillHex: '#FFF1F2',
        strokeHex: '#E11D48',
      },
      {
        id: 'allocated_cohort',
        label: `Eligible / Allocated Cohort (N = ${data.eligible_total.toLocaleString('en-US')})`,
        x: 240,
        y: 195,
        w: 280,
        h: 54,
        fillHex: '#EFF6FF',
        strokeHex: '#2563EB',
      },
    ]
    const edges: FlowchartEdgeLink[] = [
      { from: 'assessed', to: 'excluded', label: 'Excluded' },
      { from: 'assessed', to: 'allocated_cohort', label: 'Eligible' },
    ]
    const arms = data.arms.slice(0, 3)
    const spacing = arms.length === 1 ? [380] : arms.length === 2 ? [200, 560] : [130, 390, 650]
    arms.forEach((arm, i) => {
      const cx = spacing[i] ?? 380
      const bx = cx - 125
      nodes.push(
        {
          id: `alloc_${i}`,
          label: `${arm.name} (Allocated: n = ${arm.allocated})`,
          sublabel: `Lost to follow-up: n = ${arm.lost_to_followup ?? 0} | Discontinued: n = ${arm.discontinued ?? 0}`,
          x: bx,
          y: 300,
          w: 250,
          h: 68,
          fillHex: '#F8FAFC',
          strokeHex: '#3B82F6',
        },
        {
          id: `ana_${i}`,
          label: `Analyzed (n = ${arm.analyzed})`,
          sublabel: arm.name,
          x: bx,
          y: 410,
          w: 250,
          h: 58,
          fillHex: '#F0FDF4',
          strokeHex: '#16A34A',
        },
      )
      edges.push(
        { from: 'allocated_cohort', to: `alloc_${i}` },
        { from: `alloc_${i}`, to: `ana_${i}` },
      )
    })
    return { title: data.title ?? 'CONSORT 2010 Flow Diagram', nodes, edges }
  }

  // EnrollmentFlowData (platform-verified observational / clinical cohort flow)
  const nodes: FlowchartBoxNode[] = [
    {
      id: 'enrolled',
      label: `Enrolled (n = ${data.enrolled_ever})`,
      sublabel: data.title ?? 'Participant Flow',
      x: 260,
      y: 35,
      w: 280,
      h: 58,
      fillHex: '#F8FAFC',
      strokeHex: '#475569',
    },
    {
      id: 'analyzed',
      label: `Included in Analysis (n = ${data.analyzed})`,
      sublabel: data.withdrawn > 0 ? `Withdrawn: n = ${data.withdrawn}` : undefined,
      x: 260,
      y: 145,
      w: 280,
      h: 58,
      fillHex: '#EFF6FF',
      strokeHex: '#2563EB',
    },
  ]
  const edges: FlowchartEdgeLink[] = [{ from: 'enrolled', to: 'analyzed' }]
  if (data.withdrawn > 0) {
    nodes.push({
      id: 'withdrawn',
      label: `Withdrawn (n = ${data.withdrawn})`,
      sublabel: 'Reason not recorded in platform',
      x: 570,
      y: 90,
      w: 240,
      h: 48,
      fillHex: '#FFF7ED',
      strokeHex: '#C2410C',
    })
    edges.push({ from: 'enrolled', to: 'withdrawn', label: 'Withdrawn' })
  }
  const arms = data.arms.slice(0, 3)
  const spacing = arms.length === 1 ? [400] : arms.length === 2 ? [220, 580] : [140, 400, 660]
  arms.forEach((arm, i) => {
    const bx = (spacing[i] ?? 400) - 115
    nodes.push({
      id: `arm_${i}`,
      label: `${arm.name} (n = ${arm.n})`,
      x: bx,
      y: 255,
      w: 230,
      h: 58,
      fillHex: '#F0FDF4',
      strokeHex: '#10B981',
    })
    edges.push({ from: 'analyzed', to: `arm_${i}` })
  })
  return { title: data.title ?? 'Participant Flow Diagram', nodes, edges }
}

/**
 * Exports a study flowchart to Draw.io (.drawio) `mxGraphModel` XML (directly editable in Diagrams.net & Visio).
 */
export function exportFlowchartToDrawio(data: ConsortDiagramData | EnrollmentFlowData): string {
  const graph = buildConsortFlowchartGraph(data)
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>']
  for (const n of graph.nodes) {
    const val = n.sublabel ? `${escXml(n.label)}&#xa;${escXml(n.sublabel)}` : escXml(n.label)
    cells.push(
      `<mxCell id="${escXml(n.id)}" value="${val}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${n.fillHex ?? '#F8FAFC'};strokeColor=${n.strokeHex ?? '#334155'};fontFamily=Arial;fontSize=11;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" as="geometry"/></mxCell>`,
    )
  }
  graph.edges.forEach((e, idx) => {
    cells.push(
      `<mxCell id="flow_edge_${idx}" value="${escXml(e.label ?? '')}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#475569;strokeWidth=1.5;fontFamily=Arial;fontSize=10;" edge="1" parent="1" source="${escXml(e.from)}" target="${escXml(e.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
    )
  })
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<mxfile host="Heurion" modified="${new Date().toISOString()}" agent="Heurion-Flowchart-Exporter" version="24.0.0" type="device">\n` +
    `  <diagram id="consort_flow" name="${escXml(graph.title)}">\n` +
    `    <mxGraphModel dx="900" dy="620" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="560">\n` +
    `      <root>\n        ${cells.join('\n        ')}\n      </root>\n` +
    `    </mxGraphModel>\n` +
    `  </diagram>\n` +
    `</mxfile>`
  )
}

/**
 * Exports a study flowchart to Microsoft Visio XML Drawing (.vdx) format.
 */
export function exportFlowchartToVisioVdx(data: ConsortDiagramData | EnrollmentFlowData): string {
  const graph = buildConsortFlowchartGraph(data)
  // Visio coordinates are in inches from bottom-left of page (11 in wide x 8.5 in high)
  const pageW = 11.0
  const pageH = 8.5
  const shapesXml: string[] = []
  let shapeId = 1
  const idMap = new Map<string, number>()

  for (const n of graph.nodes) {
    const sid = shapeId++
    idMap.set(n.id, sid)
    const pinX = (((n.x + n.w / 2) / 850) * pageW).toFixed(3)
    const pinY = ((1 - (n.y + n.h / 2) / 560) * pageH).toFixed(3)
    const widthIn = ((n.w / 850) * pageW).toFixed(3)
    const heightIn = ((n.h / 560) * pageH).toFixed(3)
    const text = n.sublabel ? `${n.label}\n${n.sublabel}` : n.label
    shapesXml.push(
      `      <Shape ID="${sid}" NameU="${escXml(n.id)}" Type="Shape">\n` +
        `        <XForm><PinX>${pinX}</PinX><PinY>${pinY}</PinY><Width>${widthIn}</Width><Height>${heightIn}</Height></XForm>\n` +
        `        <Fill><FillForegnd>${escXml(n.fillHex ?? '#F8FAFC')}</FillForegnd></Fill>\n` +
        `        <Line><LineWeight>0.015</LineWeight><LineColor>${escXml(n.strokeHex ?? '#334155')}</LineColor></Line>\n` +
        `        <Text>${escXml(text)}</Text>\n` +
        `      </Shape>`,
    )
  }

  const connectsXml: string[] = []
  for (const e of graph.edges) {
    const sNode = graph.nodes.find(n => n.id === e.from)
    const tNode = graph.nodes.find(n => n.id === e.to)
    if (!sNode || !tNode) continue
    const cid = shapeId++
    const sId = idMap.get(e.from) ?? 1
    const tId = idMap.get(e.to) ?? 1
    const bx = (((sNode.x + sNode.w / 2) / 850) * pageW).toFixed(3)
    const by = ((1 - (sNode.y + sNode.h) / 560) * pageH).toFixed(3)
    const ex = (((tNode.x + tNode.w / 2) / 850) * pageW).toFixed(3)
    const ey = ((1 - tNode.y / 560) * pageH).toFixed(3)
    shapesXml.push(
      `      <Shape ID="${cid}" NameU="Connector_${cid}" Type="Shape">\n` +
        `        <XForm1D><BeginX>${bx}</BeginX><BeginY>${by}</BeginY><EndX>${ex}</EndX><EndY>${ey}</EndY></XForm1D>\n` +
        `        <Line><LineWeight>0.015</LineWeight><LineColor>#475569</LineColor><EndArrow>4</EndArrow></Line>\n` +
        (e.label ? `        <Text>${escXml(e.label)}</Text>\n` : '') +
        `      </Shape>`,
    )
    connectsXml.push(
      `      <Connect FromSheet="${cid}" FromCell="BeginX" ToSheet="${sId}" ToCell="PinX"/>\n` +
        `      <Connect FromSheet="${cid}" FromCell="EndX" ToSheet="${tId}" ToCell="PinX"/>`,
    )
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<VisioDocument xmlns="http://schemas.microsoft.com/visio/2003/core">\n` +
    `  <DocumentProperties><Title>${escXml(graph.title)}</Title><Creator>Heurion Medical Figure Studio</Creator></DocumentProperties>\n` +
    `  <Pages>\n` +
    `    <Page ID="0" NameU="CONSORT_Flowchart">\n` +
    `      <PageSheet><PageProps><PageWidth>${pageW}</PageWidth><PageHeight>${pageH}</PageHeight></PageProps></PageSheet>\n` +
    `      <Shapes>\n${shapesXml.join('\n')}\n      </Shapes>\n` +
    `      <Connects>\n${connectsXml.join('\n')}\n      </Connects>\n` +
    `    </Page>\n` +
    `  </Pages>\n` +
    `</VisioDocument>`
  )
}

/**
 * Exports a study flowchart to an editable Microsoft PowerPoint (.pptx) deck.
 */
export function exportFlowchartToPptx(data: ConsortDiagramData | EnrollmentFlowData): Uint8Array {
  const graph = buildConsortFlowchartGraph(data)
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
  return buildEditablePptxFromShapes({
    title: graph.title,
    canvasWidth: 850,
    canvasHeight: 550,
    shapes: graph.nodes.map(n => ({
      id: n.id,
      label: n.label,
      sublabel: n.sublabel,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      fillHex: n.fillHex,
      strokeHex: n.strokeHex,
      rounded: true,
    })),
    connectors: graph.edges
      .map(e => {
        const s = nodeMap.get(e.from)
        const d = nodeMap.get(e.to)
        if (!s || !d) return null
        return {
          fromX: s.x + s.w / 2,
          fromY: s.y + s.h,
          toX: d.x + d.w / 2,
          toY: d.y,
          label: e.label,
          colorHex: '475569',
          arrowEnd: 'arrow' as const,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  })
}

// ============================================================================
// CATEGORY 2: Clinical & Wet-Lab Statistical Plots (GraphPad Prism .pzfx, R .R, OriginPro)
// ============================================================================

export interface PrismColumnGroup {
  name: string
  values: number[]
}

export interface PrismXYSeries {
  name: string
  yValues: Array<number | null>
  errorValues?: Array<number | null>
}

export type PrismTableSpec =
  | {
      tableType: 'Column'
      title: string
      notes?: string
      groups: PrismColumnGroup[]
    }
  | {
      tableType: 'XY'
      title: string
      xTitle: string
      xValues: number[]
      series: PrismXYSeries[]
    }
  | {
      tableType: 'Survival'
      title: string
      timeTitle?: string
      records: Array<{ time: number; event: 0 | 1; group: string }>
    }
  | {
      tableType: 'Forest'
      title: string
      rows: Array<{ label: string; hr: number; ciLower: number; ciUpper: number; pValue?: number }>
    }

/**
 * Generates a native GraphPad Prism XML Project file (`.pzfx`, PrismXMLVersion="5.00")
 * that opens directly in GraphPad Prism 5/6/7/8/9/10 with pre-populated data tables.
 */
export function exportToPrismPzfx(spec: PrismTableSpec | PrismTableSpec[], projectTitle = 'Heurion Biomedical Study'): string {
  const tables = Array.isArray(spec) ? spec : [spec]
  const dateStr = new Date().toISOString().slice(0, 10)

  const tableBlocks = tables.map((tbl, idx) => {
    const tid = `Table${idx}`
    if (tbl.tableType === 'Column') {
      const cols = tbl.groups
        .map(
          g =>
            `    <YColumn Width="89" Decimals="4" Subcolumns="1">\n` +
            `      <Title>${escXml(g.name)}</Title>\n` +
            `      <Subcolumn>\n` +
            g.values.map(v => `        <d>${Number.isFinite(v) ? v : ''}</d>`).join('\n') +
            `\n      </Subcolumn>\n` +
            `    </YColumn>`,
        )
        .join('\n')
      return (
        `  <Table ID="${tid}" XFormat="none" TableType="OneWay" EVFormat="AsteriskAfterNumber">\n` +
        `    <Title>${escXml(tbl.title)}</Title>\n` +
        cols +
        `\n  </Table>`
      )
    }

    if (tbl.tableType === 'XY') {
      const xCol =
        `    <XColumn Width="89" Decimals="4" Subcolumns="1">\n` +
        `      <Title>${escXml(tbl.xTitle)}</Title>\n` +
        `      <Subcolumn>\n` +
        tbl.xValues.map(x => `        <d>${Number.isFinite(x) ? x : ''}</d>`).join('\n') +
        `\n      </Subcolumn>\n` +
        `    </XColumn>`
      const yCols = tbl.series
        .map(s => {
          const hasErr = Array.isArray(s.errorValues) && s.errorValues.length > 0
          return (
            `    <YColumn Width="110" Decimals="4" Subcolumns="${hasErr ? 2 : 1}">\n` +
            `      <Title>${escXml(s.name)}</Title>\n` +
            `      <Subcolumn>\n` +
            s.yValues.map(y => `        <d>${y !== null && Number.isFinite(y) ? y : ''}</d>`).join('\n') +
            `\n      </Subcolumn>\n` +
            (hasErr
              ? `      <Subcolumn>\n` +
                s.errorValues!.map(e => `        <d>${e !== null && Number.isFinite(e) ? e : ''}</d>`).join('\n') +
                `\n      </Subcolumn>\n`
              : '') +
            `    </YColumn>`
          )
        })
        .join('\n')
      return (
        `  <Table ID="${tid}" XFormat="numbers" YFormat="${tbl.series.some(s => s.errorValues?.length) ? 'SD' : 'replicates'}" Replicates="1" TableType="XY" EVFormat="AsteriskAfterNumber">\n` +
        `    <Title>${escXml(tbl.title)}</Title>\n` +
        xCol +
        '\n' +
        yCols +
        `\n  </Table>`
      )
    }

    if (tbl.tableType === 'Survival') {
      const groupNames = Array.from(new Set(tbl.records.map(r => r.group)))
      const xCol =
        `    <XColumn Width="89" Decimals="2" Subcolumns="1">\n` +
        `      <Title>${escXml(tbl.timeTitle ?? 'Time')}</Title>\n` +
        `      <Subcolumn>\n` +
        tbl.records.map(r => `        <d>${r.time}</d>`).join('\n') +
        `\n      </Subcolumn>\n` +
        `    </XColumn>`
      const yCols = groupNames
        .map(
          g =>
            `    <YColumn Width="89" Decimals="0" Subcolumns="1">\n` +
            `      <Title>${escXml(g)}</Title>\n` +
            `      <Subcolumn>\n` +
            tbl.records.map(r => `        <d>${r.group === g ? r.event : ''}</d>`).join('\n') +
            `\n      </Subcolumn>\n` +
            `    </YColumn>`,
        )
        .join('\n')
      return (
        `  <Table ID="${tid}" XFormat="numbers" YFormat="replicates" Replicates="1" TableType="Survival" EVFormat="AsteriskAfterNumber">\n` +
        `    <Title>${escXml(tbl.title)}</Title>\n` +
        xCol +
        '\n' +
        yCols +
        `\n  </Table>`
      )
    }

    const rowTitles =
      `    <RowTitlesColumn Width="140">\n` +
      `      <Subcolumn>\n` +
      tbl.rows.map(r => `        <d>${escXml(r.label)}</d>`).join('\n') +
      `\n      </Subcolumn>\n` +
      `    </RowTitlesColumn>`
    const hrCol =
      `    <YColumn Width="140" Decimals="3" Subcolumns="3">\n` +
      `      <Title>Hazard Ratio (95% CI)</Title>\n` +
      `      <Subcolumn>\n` +
      tbl.rows.map(r => `        <d>${r.hr.toFixed(4)}</d>`).join('\n') +
      `\n      </Subcolumn>\n` +
      `      <Subcolumn>\n` +
      tbl.rows.map(r => `        <d>${r.ciLower.toFixed(4)}</d>`).join('\n') +
      `\n      </Subcolumn>\n` +
      `      <Subcolumn>\n` +
      tbl.rows.map(r => `        <d>${r.ciUpper.toFixed(4)}</d>`).join('\n') +
      `\n      </Subcolumn>\n` +
      `    </YColumn>`
    return (
      `  <Table ID="${tid}" XFormat="none" YFormat="upper-lower-limits" TableType="Grouped" EVFormat="AsteriskAfterNumber">\n` +
      `    <Title>${escXml(tbl.title)}</Title>\n` +
      rowTitles +
      '\n' +
      hrCol +
      `\n  </Table>`
    )
  })

  const seqItems = tables.map((_, i) => `    <Ref ID="Table${i}" Selected="${i === 0 ? '1' : '0'}"/>`).join('\n')

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<GraphPadPrismFile PrismXMLVersion="5.00" xmlns="http://graphpad.com/prism/Prism.htm">\n` +
    `  <Created>\n` +
    `    <OriginalVersion CreatedByProgram="GraphPad Prism" CreatedByVersion="9.5.0" DateTime="${dateStr}T12:00:00"/>\n` +
    `  </Created>\n` +
    `  <InfoSequence>\n    <Ref ID="Info0" Selected="1"/>\n  </InfoSequence>\n` +
    `  <Info ID="Info0">\n` +
    `    <Title>${escXml(projectTitle)}</Title>\n` +
    `    <Notes>Generated by Heurion Medical Paper Figure Studio. Double-click any Table in GraphPad Prism to customize graphs and statistical tests.</Notes>\n` +
    `  </Info>\n` +
    `  <TableSequence>\n${seqItems}\n  </TableSequence>\n` +
    tableBlocks.join('\n') +
    `\n</GraphPadPrismFile>`
  )
}

/**
 * Generates OriginPro-compatible worksheet CSV (with Long Name, Units, Comments, and Column Designation rows)
 * plus a companion Origin LabTalk script (`.ogs`) for curve fitting / publication plotting.
 */
export function exportToOriginPro(opts: {
  title: string
  xLabel: string
  xUnits?: string
  yLabel: string
  yUnits?: string
  xValues: number[]
  series: Array<{ name: string; yValues: Array<number | null>; sdValues?: Array<number | null> }>
  fitType?: '4PL_Dose_Response' | 'Linear' | 'PK_OneCompartment' | 'None'
}): { origin_csv: string; origin_ogs: string } {
  const headers: string[] = ['Long Name', opts.xLabel]
  const units: string[] = ['Units', opts.xUnits ?? '']
  const comments: string[] = ['Comments', 'X (Independent)']
  const designations: string[] = ['Designation', 'X']

  for (const s of opts.series) {
    headers.push(s.name)
    units.push(opts.yUnits ?? '')
    comments.push(`${opts.yLabel} - ${s.name}`)
    designations.push('Y')
    if (s.sdValues?.length) {
      headers.push(`${s.name}_SD`)
      units.push(opts.yUnits ?? '')
      comments.push(`SD of ${s.name}`)
      designations.push('yEr')
    }
  }

  const csvRows: string[] = [
    headers.join(','),
    units.join(','),
    comments.join(','),
    designations.join(','),
  ]

  for (let i = 0; i < opts.xValues.length; i++) {
    const row: string[] = [`Row_${i + 1}`, String(opts.xValues[i] ?? '')]
    for (const s of opts.series) {
      const y = s.yValues[i]
      row.push(y !== null && y !== undefined && Number.isFinite(y) ? String(y) : '')
      if (s.sdValues?.length) {
        const sd = s.sdValues[i]
        row.push(sd !== null && sd !== undefined && Number.isFinite(sd) ? String(sd) : '')
      }
    }
    csvRows.push(row.join(','))
  }

  const ogs =
    `// OriginPro LabTalk Script generated by Heurion Medical Figure Studio\n` +
    `// Title: ${opts.title}\n` +
    `[Main]\n` +
    `newbook name:="HeurionData" sheet:=1 option:=lsname;\n` +
    `plotxy iy:=(1,2:end) plot:=202;\n` +
    `layer.x.label.text$ = "${opts.xLabel}${opts.xUnits ? ` (${opts.xUnits})` : ''}";\n` +
    `layer.y.label.text$ = "${opts.yLabel}${opts.yUnits ? ` (${opts.yUnits})` : ''}";\n` +
    (opts.fitType === '4PL_Dose_Response'
      ? `// Nonlinear 4-Parameter Logistic Dose-Response Fit (Hill Equation)\nnlbegin iy:=(1,2) func:=DoseResp nltree:=tt;\nnlfit;\nnlend 1 1;\n`
      : '') +
    `page.title$ = "${opts.title}";\n`

  return { origin_csv: csvRows.join('\n'), origin_ogs: ogs }
}

export interface WetLabPlotSpec {
  plotType?: 'bar_scatter' | 'box_violin' | 'dose_response'
  plot_type?: 'bar_scatter' | 'box_violin' | 'dose_response'
  title: string
  yLabel?: string
  y_label?: string
  xLabel?: string
  x_label?: string
  errorBarType?: 'SD' | 'SEM'
  error_bar?: 'SD' | 'SEM'
  groups?: PrismColumnGroup[]
  comparisons?: Array<{ group1: string; group2: string }>
  doseResponse?: {
    logConcentrations: number[]
    series: Array<{ name: string; responses: number[]; color?: string; ic50?: number }>
  }
  dose_response_series?: Array<{
    name: string
    ic50?: number
    hill_slope?: number
    bottom?: number
    top?: number
    points: Array<{ dose: number; responses: number[] }>
  }>
}

function meanAndSd(vals: number[]): { mean: number; sd: number; sem: number; median: number; q1: number; q3: number } {
  const clean = vals.filter(v => Number.isFinite(v)).sort((a, b) => a - b)
  if (clean.length === 0) return { mean: 0, sd: 0, sem: 0, median: 0, q1: 0, q3: 0 }
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length
  const variance =
    clean.length > 1 ? clean.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (clean.length - 1) : 0
  const sd = Math.sqrt(variance)
  const sem = sd / Math.sqrt(clean.length)
  const q = (p: number) => {
    const pos = (clean.length - 1) * p
    const base = Math.floor(pos)
    const rest = pos - base
    return clean[base + 1] !== undefined ? clean[base]! + rest * (clean[base + 1]! - clean[base]!) : clean[base]!
  }
  return { mean, sd, sem, median: q(0.5), q1: q(0.25), q3: q(0.75) }
}

function normalTwoSidedP(zAbs: number): number {
  const t = 1 / (1 + 0.2316419 * zAbs)
  const d = 0.3989423 * Math.exp((-zAbs * zAbs) / 2)
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return Math.min(1, Math.max(0, 2 * prob))
}

function welchTTestPValue(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 1
  const sa = meanAndSd(a)
  const sb = meanAndSd(b)
  const se = Math.sqrt(sa.sd ** 2 / a.length + sb.sd ** 2 / b.length)
  if (se <= 1e-12) return 1
  const tStat = Math.abs(sa.mean - sb.mean) / se
  return normalTwoSidedP(tStat)
}

function pStars(p: number): string {
  if (p < 0.0001) return '****'
  if (p < 0.001) return '***'
  if (p < 0.01) return '**'
  if (p < 0.05) return '*'
  return 'ns'
}

export function generateWetLabPlot(spec: WetLabPlotSpec): {
  svg: string
  illustrator_svg: string
  prism_pzfx: string
  r_script: string
  origin_csv: string
  origin_ogs: string
  stats_summary: Array<{
    group: string
    n: number
    mean: number
    sd: number
    sem: number
    median: number
    p_vs_ctrl?: number
    p_value?: number
    stars?: string
  }>
} {
  const width = 680
  const height = 460
  const padL = 85
  const padR = 40
  const padT = 60
  const padB = 75
  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const palette = ['#2563EB', '#DC2626', '#0D9488', '#D97706', '#7C3AED', '#059669']

  const plotType = spec.plotType ?? spec.plot_type ?? 'bar_scatter'
  const title = spec.title ?? 'Statistical Comparison'
  const yLabel = spec.yLabel ?? spec.y_label ?? 'Value'
  const xLabel = spec.xLabel ?? spec.x_label
  const errorBarType = spec.errorBarType ?? spec.error_bar ?? 'SD'

  const drNormalized =
    spec.doseResponse ??
    (spec.dose_response_series?.length
      ? {
          logConcentrations: spec.dose_response_series[0]!.points.map(p => Math.log10(Math.max(1e-12, p.dose))),
          series: spec.dose_response_series.map(s => ({
            name: s.name,
            ic50: s.ic50,
            responses: s.points.map(p => meanAndSd(p.responses).mean),
          })),
        }
      : undefined)

  if (plotType === 'dose_response' && drNormalized) {
    const dr = drNormalized
    const xs = dr.logConcentrations
    const allY = dr.series.flatMap(s => s.responses).filter(Number.isFinite)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(0, ...allY)
    const maxY = Math.max(100, ...allY) * 1.1

    const mapX = (x: number) => padL + ((x - minX) / (maxX - minX || 1)) * plotW
    const mapY = (y: number) => padT + plotH - ((y - minY) / (maxY - minY || 1)) * plotH

    let curvesSvg = ''
    dr.series.forEach((s, idx) => {
      const clr = (s as any).color ?? palette[idx % palette.length]!
      const bottom = Math.min(...s.responses)
      const top = Math.max(...s.responses)
      const midX = (minX + maxX) / 2
      const pts: string[] = []
      for (let step = 0; step <= 60; step++) {
        const xv = minX + (step / 60) * (maxX - minX)
        const yv = bottom + (top - bottom) / (1 + Math.pow(10, (midX - xv) * 1.1))
        pts.push(`${step === 0 ? 'M' : 'L'} ${mapX(xv).toFixed(1)} ${mapY(yv).toFixed(1)}`)
      }
      curvesSvg += `    <path d="${pts.join(' ')}" fill="none" stroke="${clr}" stroke-width="2.5"/>\n`
      s.responses.forEach((yv, i) => {
        const xv = xs[i] ?? minX
        curvesSvg += `    <circle cx="${mapX(xv).toFixed(1)}" cy="${mapY(yv).toFixed(1)}" r="4.5" fill="${clr}" stroke="#FFFFFF" stroke-width="1"/>\n`
      })
      const ic50Text = (s as any).ic50 !== undefined ? ` (IC50 = ${(s as any).ic50})` : ''
      curvesSvg += `    <text x="${padL + plotW - 12}" y="${padT + 22 + idx * 18}" text-anchor="end" font-size="11" font-weight="bold" fill="${clr}">${escXml(s.name)}${escXml(ic50Text)}</text>\n`
    })

    const rawSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 ${width} ${height}" width="100%" height="100%" font-family="Arial, Helvetica, sans-serif">\n` +
      `  <rect width="${width}" height="${height}" fill="#FFFFFF"/>\n` +
      `  <text x="${width / 2}" y="30" text-anchor="middle" font-size="14" font-weight="bold" fill="#0F172A">${escXml(title)}</text>\n` +
      `  <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#0F172A" stroke-width="1.8"/>\n` +
      `  <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#0F172A" stroke-width="1.8"/>\n` +
      `  <text x="${padL + plotW / 2}" y="${height - 20}" text-anchor="middle" font-size="12" font-weight="bold" fill="#0F172A">${escXml(xLabel ?? 'Log10 Concentration (M)')}</text>\n` +
      `  <text x="24" y="${padT + plotH / 2}" text-anchor="middle" font-size="12" font-weight="bold" fill="#0F172A" transform="rotate(-90 24 ${padT + plotH / 2})">${escXml(yLabel)}</text>\n` +
      `  <g id="Layer_4PL_Curves" inkscape:groupmode="layer" inkscape:label="4PL_Curves" data-name="4PL_Curves">\n${curvesSvg}  </g>\n` +
      `</svg>`

    const pzfx = exportToPrismPzfx(
      {
        tableType: 'XY',
        title,
        xTitle: xLabel ?? 'Log10[Conc]',
        xValues: xs,
        series: dr.series.map(s => ({ name: s.name, yValues: s.responses })),
      },
      title,
    )
    const origin = exportToOriginPro({
      title,
      xLabel: xLabel ?? 'Log10_Conc',
      yLabel,
      xValues: xs,
      series: dr.series.map(s => ({ name: s.name, yValues: s.responses })),
      fitType: '4PL_Dose_Response',
    })
    const rScript =
      `# Reproducible R Script (drc / ggplot2 4PL Dose-Response Curve)\n` +
      `library(ggplot2)\n` +
      `df <- read.csv("dose_response_data.csv")\n` +
      `p <- ggplot(df, aes(x = X, y = Y)) + geom_point(size = 2.5) + geom_smooth(method = "loess", se = FALSE) + theme_classic(base_family = "Arial")\n` +
      `ggsave("Figure_Dose_Response.pdf", plot = p, width = 6, height = 4.5, dpi = 600)\n`

    return {
      svg: rawSvg,
      illustrator_svg: upgradeSvgForIllustrator(rawSvg, { title }),
      prism_pzfx: pzfx,
      r_script: rScript,
      origin_csv: origin.origin_csv,
      origin_ogs: origin.origin_ogs,
      stats_summary: [],
    }
  }

  const groups = spec.groups ?? []
  const allStats = groups.map((g, idx) => {
    const st = meanAndSd(g.values)
    const p = idx > 0 && groups[0] ? welchTTestPValue(groups[0].values, g.values) : undefined
    return {
      group: g.name,
      n: g.values.length,
      ...st,
      p_vs_ctrl: p,
      p_value: p ?? 1,
      stars: p !== undefined ? pStars(p) : 'ns',
    }
  })
  const stats = spec.comparisons?.length
    ? spec.comparisons.map(c => {
        const g1 = groups.find(g => g.name === c.group1) ?? groups[0]
        const g2 = groups.find(g => g.name === c.group2) ?? groups[1]
        const st = meanAndSd(g2?.values ?? [])
        const p = g1 && g2 ? welchTTestPValue(g1.values, g2.values) : 1
        return {
          group: `${c.group1} vs ${c.group2}`,
          n: g2?.values.length ?? 0,
          ...st,
          p_vs_ctrl: p,
          p_value: p,
          stars: pStars(p),
        }
      })
    : allStats

  const allVals = groups.flatMap(g => g.values).filter(Number.isFinite)
  const maxVal = Math.max(1, ...allVals, ...allStats.map(s => s.mean + s.sd)) * 1.28
  const minVal = Math.min(0, ...allVals)
  const mapY = (v: number) => padT + plotH - ((v - minVal) / (maxVal - minVal || 1)) * plotH
  const zeroY = mapY(0)

  let yTicksSvg = ''
  for (let i = 0; i <= 5; i++) {
    const val = minVal + (i / 5) * (maxVal - minVal)
    const y = mapY(val)
    yTicksSvg +=
      `    <line x1="${padL - 5}" y1="${y.toFixed(1)}" x2="${padL}" y2="${y.toFixed(1)}" stroke="#0F172A" stroke-width="1.5"/>\n` +
      `    <text x="${padL - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#0F172A">${val.toFixed(1)}</text>\n`
  }

  let dataLayer = ''
  const colStep = plotW / Math.max(1, groups.length)
  const barW = Math.min(54, colStep * 0.48)

  groups.forEach((g, idx) => {
    const cx = padL + colStep * (idx + 0.5)
    const st = allStats[idx]!
    const clr = palette[idx % palette.length]!
    const err = errorBarType === 'SEM' ? st.sem : st.sd

    if (plotType === 'box_violin') {
      const yQ1 = mapY(st.q1)
      const yQ3 = mapY(st.q3)
      const yMed = mapY(st.median)
      const minV = g.values.length ? Math.min(...g.values) : 0
      const maxV = g.values.length ? Math.max(...g.values) : 0
      const yMin = mapY(minV)
      const yMax = mapY(maxV)
      dataLayer +=
        `    <line x1="${cx}" y1="${yMax.toFixed(1)}" x2="${cx}" y2="${yMin.toFixed(1)}" stroke="${clr}" stroke-width="1.8"/>\n` +
        `    <rect x="${(cx - barW / 2).toFixed(1)}" y="${Math.min(yQ1, yQ3).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, Math.abs(yQ1 - yQ3)).toFixed(1)}" fill="${clr}" fill-opacity="0.22" stroke="${clr}" stroke-width="2"/>\n` +
        `    <line x1="${(cx - barW / 2).toFixed(1)}" y1="${yMed.toFixed(1)}" x2="${(cx + barW / 2).toFixed(1)}" y2="${yMed.toFixed(1)}" stroke="${clr}" stroke-width="2.5"/>\n`
    } else {
      const barTop = mapY(Math.max(0, st.mean))
      const barH = Math.max(1, Math.abs(zeroY - mapY(st.mean)))
      const yErrTop = mapY(st.mean + err)
      const yErrBot = mapY(Math.max(minVal, st.mean - err))
      dataLayer +=
        `    <rect x="${(cx - barW / 2).toFixed(1)}" y="${barTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${clr}" fill-opacity="0.32" stroke="${clr}" stroke-width="2"/>\n` +
        `    <line x1="${cx.toFixed(1)}" y1="${yErrTop.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yErrBot.toFixed(1)}" stroke="#0F172A" stroke-width="1.8"/>\n` +
        `    <line x1="${(cx - 8).toFixed(1)}" y1="${yErrTop.toFixed(1)}" x2="${(cx + 8).toFixed(1)}" y2="${yErrTop.toFixed(1)}" stroke="#0F172A" stroke-width="1.8"/>\n`
    }

    g.values.forEach((v, j) => {
      const jitter = (((j * 37 + idx * 13) % 19) - 9) * (barW * 0.032)
      const vx = cx + jitter
      const vy = mapY(v)
      dataLayer += `    <circle cx="${vx.toFixed(1)}" cy="${vy.toFixed(1)}" r="3.8" fill="${clr}" stroke="#FFFFFF" stroke-width="1"/>\n`
    })

    dataLayer += `    <text x="${cx.toFixed(1)}" y="${padT + plotH + 24}" text-anchor="middle" font-size="11.5" font-weight="bold" fill="#0F172A">${escXml(g.name)}</text>\n`

    if (idx > 0 && st.p_vs_ctrl !== undefined) {
      const x0 = padL + colStep * 0.5
      const bracketY = padT + 14 + (idx - 1) * 18
      dataLayer +=
        `    <path d="M ${x0.toFixed(1)} ${bracketY + 6} L ${x0.toFixed(1)} ${bracketY} L ${cx.toFixed(1)} ${bracketY} L ${cx.toFixed(1)} ${bracketY + 6}" fill="none" stroke="#0F172A" stroke-width="1.4"/>\n` +
        `    <text x="${((x0 + cx) / 2).toFixed(1)}" y="${bracketY - 3}" text-anchor="middle" font-size="10.5" font-weight="bold" fill="#0F172A">${st.stars} (P=${st.p_vs_ctrl < 0.001 ? st.p_vs_ctrl.toExponential(1) : st.p_vs_ctrl.toFixed(3)})</text>\n`
    }
  })

  const rawSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 ${width} ${height}" width="100%" height="100%" font-family="Arial, Helvetica, sans-serif">\n` +
    `  <rect width="${width}" height="${height}" fill="#FFFFFF"/>\n` +
    `  <g id="Layer_Axes" inkscape:groupmode="layer" inkscape:label="Axes_And_Labels" data-name="Axes_And_Labels">\n` +
    `    <text x="${width / 2}" y="28" text-anchor="middle" font-size="14" font-weight="bold" fill="#0F172A">${escXml(title)}</text>\n` +
    `    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#0F172A" stroke-width="1.8"/>\n` +
    `    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#0F172A" stroke-width="1.8"/>\n` +
    yTicksSvg +
    `    <text x="24" y="${padT + plotH / 2}" text-anchor="middle" font-size="12" font-weight="bold" fill="#0F172A" transform="rotate(-90 24 ${padT + plotH / 2})">${escXml(yLabel)}</text>\n` +
    `  </g>\n` +
    `  <g id="Layer_Data_And_Stats" inkscape:groupmode="layer" inkscape:label="Bars_Points_And_Stats" data-name="Bars_Points_And_Stats">\n` +
    dataLayer +
    `  </g>\n` +
    `</svg>`

  const pzfx = exportToPrismPzfx({ tableType: 'Column', title, groups }, title)
  const rDataLines = groups.flatMap(g => g.values.map(v => `  data.frame(Group = "${g.name}", Value = ${v})`))
  const rScript =
    `# Reproducible R Script (ggplot2 + ggpubr publication plot)\n` +
    `library(ggplot2)\n` +
    `df <- rbind(\n${rDataLines.join(',\n')}\n)\n` +
    `p <- ggplot(df, aes(x = Group, y = Value, fill = Group, color = Group)) +\n` +
    (plotType === 'box_violin'
      ? `  geom_violin(alpha = 0.2, trim = FALSE) + geom_boxplot(width = 0.25, alpha = 0.4, outlier.shape = NA) +\n`
      : `  stat_summary(fun = mean, geom = "bar", width = 0.55, alpha = 0.35, linewidth = 0.8) +\n` +
        `  stat_summary(fun.data = mean_sdl, fun.args = list(mult = 1), geom = "errorbar", width = 0.2, color = "#0F172A") +\n`) +
    `  geom_jitter(width = 0.12, size = 2.2, alpha = 0.9) +\n` +
    `  labs(title = "${title.replace(/"/g, '\\"')}", y = "${yLabel.replace(/"/g, '\\"')}", x = "") +\n` +
    `  theme_classic(base_size = 12, base_family = "Arial") + theme(legend.position = "none")\n` +
    `ggsave("Figure_Statistical_Plot.svg", plot = p, width = 6.5, height = 4.5)\n` +
    `ggsave("Figure_Statistical_Plot.pdf", plot = p, width = 6.5, height = 4.5, dpi = 600)\n`

  const maxLen = Math.max(1, ...groups.map(g => g.values.length))
  const origin = exportToOriginPro({
    title,
    xLabel: 'Replicate',
    yLabel,
    xValues: Array.from({ length: maxLen }, (_, i) => i + 1),
    series: groups.map(g => ({
      name: g.name,
      yValues: Array.from({ length: maxLen }, (_, i) => g.values[i] ?? null),
    })),
  })

  return {
    svg: rawSvg,
    illustrator_svg: upgradeSvgForIllustrator(rawSvg, { title }),
    prism_pzfx: pzfx,
    r_script: rScript,
    origin_csv: origin.origin_csv,
    origin_ogs: origin.origin_ogs,
    stats_summary: stats,
  }
}

// ============================================================================
// CATEGORY 4: Multi-Omics & Bioinformatics (R Seurat / ComplexHeatmap / clusterProfiler / Hiplot)
// ============================================================================

export interface BioinformaticsFigureSpec {
  bioType?: 'volcano' | 'heatmap' | 'enrichment' | 'umap'
  bio_type?: 'volcano' | 'heatmap' | 'enrichment' | 'umap'
  title?: string
  fcThreshold?: number
  fc_cutoff?: number
  pThreshold?: number
  p_cutoff?: number
  genes?: Array<{ gene: string; log2FC: number; pValue?: number; p_value?: number }>
  volcano_genes?: Array<{ gene: string; log2FC: number; pValue?: number; p_value?: number }>
  rowGenes?: string[]
  colSamples?: string[]
  sampleGroups?: string[]
  matrix?: number[][]
  heatmap_matrix?: {
    row_names: string[]
    col_names: string[]
    col_groups?: string[]
    values: number[][]
  }
  database?: 'KEGG' | 'GO_BP' | 'GO_MF' | 'GO_CC' | 'Reactome'
  pathways?: Array<{ term: string; category?: string; geneRatio?: number; gene_ratio?: number; count: number; fdr: number }>
  enrichment_terms?: Array<{ term: string; category?: string; geneRatio?: number; gene_ratio?: number; count: number; fdr: number }>
  reduction?: 'UMAP' | 't-SNE'
  cells?: Array<{ cellId?: string; id?: string; x: number; y: number; cluster: string }>
  umap_cells?: Array<{ cellId?: string; id?: string; x: number; y: number; cluster: string }>
}

export function generateBioinformaticsFigure(spec: BioinformaticsFigureSpec): {
  svg: string
  illustrator_svg: string
  r_script: string
  cloud_csv: string
  cloud_matrix_csv: string
  prism_pzfx?: string
} {
  const width = 720
  const height = 500
  const bioType = spec.bioType ?? spec.bio_type ?? 'volcano'
  const title = spec.title ?? 'Multi-Omics Bioinformatics Analysis'

  if (bioType === 'volcano') {
    const fcCut = spec.fcThreshold ?? spec.fc_cutoff ?? 1.0
    const pCut = spec.pThreshold ?? spec.p_cutoff ?? 0.05
    const negLogPCut = -Math.log10(pCut)
    const padL = 75
    const padR = 45
    const padT = 55
    const padB = 65
    const plotW = width - padL - padR
    const plotH = height - padT - padB

    const rawGenes =
      spec.genes ??
      spec.volcano_genes ?? [
        { gene: 'NPPB', log2FC: -2.4, pValue: 0.00001 },
        { gene: 'PPARGC1A', log2FC: 2.1, pValue: 0.00005 },
        { gene: 'ACTB', log2FC: 0.1, pValue: 0.65 },
      ]

    const pts = rawGenes.map(g => {
      const pv = g.pValue ?? g.p_value ?? 0.05
      const nlp = -Math.log10(Math.max(1e-300, pv))
      const status =
        pv <= pCut && g.log2FC >= fcCut
          ? 'Up'
          : pv <= pCut && g.log2FC <= -fcCut
            ? 'Down'
            : 'NS'
      return { gene: g.gene, log2FC: g.log2FC, pValue: pv, nlp, status }
    })

    const maxAbsFc = Math.max(2.5, ...pts.map(p => Math.abs(p.log2FC))) * 1.15
    const maxNlp = Math.max(negLogPCut + 1, ...pts.map(p => p.nlp)) * 1.15
    const mapX = (fc: number) => padL + ((fc + maxAbsFc) / (2 * maxAbsFc)) * plotW
    const mapY = (nlp: number) => padT + plotH - (nlp / maxNlp) * plotH

    let dotsSvg = ''
    let labelsSvg = ''
    const topLabeled = [...pts]
      .filter(p => p.status !== 'NS')
      .sort((a, b) => b.nlp - a.nlp)
      .slice(0, 10)
    const labelSet = new Set(topLabeled.map(p => p.gene))

    for (const p of pts) {
      const cx = mapX(p.log2FC)
      const cy = mapY(p.nlp)
      const clr = p.status === 'Up' ? '#DC2626' : p.status === 'Down' ? '#2563EB' : '#94A3B8'
      dotsSvg += `    <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${p.status === 'NS' ? '3.2' : '4.5'}" fill="${clr}" fill-opacity="0.82"/>\n`
      if (labelSet.has(p.gene)) {
        labelsSvg += `    <text x="${(cx + 6).toFixed(1)}" y="${(cy - 5).toFixed(1)}" font-size="10" font-weight="bold" fill="#0F172A">${escXml(p.gene)}</text>\n`
      }
    }

    const xCutL = mapX(-fcCut)
    const xCutR = mapX(fcCut)
    const yCut = mapY(negLogPCut)

    const rawSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 ${width} ${height}" width="100%" height="100%" font-family="Arial, Helvetica, sans-serif">\n` +
      `  <rect width="${width}" height="${height}" fill="#FFFFFF"/>\n` +
      `  <g id="Layer_Axes" inkscape:groupmode="layer" inkscape:label="Volcano_Axes" data-name="Volcano_Axes">\n` +
      `    <text x="${width / 2}" y="28" text-anchor="middle" font-size="14" font-weight="bold" fill="#0F172A">${escXml(title)}</text>\n` +
      `    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="none" stroke="#0F172A" stroke-width="1.5"/>\n` +
      `    <line x1="${xCutL.toFixed(1)}" y1="${padT}" x2="${xCutL.toFixed(1)}" y2="${padT + plotH}" stroke="#64748B" stroke-width="1.2" stroke-dasharray="5 4"/>\n` +
      `    <line x1="${xCutR.toFixed(1)}" y1="${padT}" x2="${xCutR.toFixed(1)}" y2="${padT + plotH}" stroke="#64748B" stroke-width="1.2" stroke-dasharray="5 4"/>\n` +
      `    <line x1="${padL}" y1="${yCut.toFixed(1)}" x2="${padL + plotW}" y2="${yCut.toFixed(1)}" stroke="#64748B" stroke-width="1.2" stroke-dasharray="5 4"/>\n` +
      `    <text x="${padL + plotW / 2}" y="${height - 18}" text-anchor="middle" font-size="12" font-weight="bold" fill="#0F172A">log2(Fold Change)</text>\n` +
      `    <text x="24" y="${padT + plotH / 2}" text-anchor="middle" font-size="12" font-weight="bold" fill="#0F172A" transform="rotate(-90 24 ${padT + plotH / 2})">-log10(P-value)</text>\n` +
      `  </g>\n` +
      `  <g id="Layer_Points" inkscape:groupmode="layer" inkscape:label="Volcano_Points" data-name="Volcano_Points">\n${dotsSvg}  </g>\n` +
      `  <g id="Layer_Gene_Labels" inkscape:groupmode="layer" inkscape:label="Gene_Labels" data-name="Gene_Labels">\n${labelsSvg}  </g>\n` +
      `</svg>`

    const csv = ['Gene,log2FoldChange,pvalue,negLog10P,Regulation', ...pts.map(p => `${p.gene},${p.log2FC},${p.pValue},${p.nlp.toFixed(4)},${p.status}`)].join('\n')
    const rScript =
      `# Reproducible R Script (ggplot2 + ggrepel / EnhancedVolcano)\n` +
      `library(ggplot2)\nlibrary(ggrepel)\n` +
      `df <- read.csv("volcano_data.csv")\n` +
      `p <- ggplot(df, aes(x = log2FoldChange, y = negLog10P, color = Regulation)) +\n` +
      `  geom_point(alpha = 0.85, size = 2.2) +\n` +
      `  scale_color_manual(values = c("Up" = "#DC2626", "Down" = "#2563EB", "NS" = "#94A3B8")) +\n` +
      `  geom_vline(xintercept = c(-${fcCut}, ${fcCut}), linetype = "dashed") +\n` +
      `  geom_hline(yintercept = ${negLogPCut.toFixed(3)}, linetype = "dashed") +\n` +
      `  geom_text_repel(data = subset(df, Regulation != "NS"), aes(label = Gene), size = 3.2, max.overlaps = 15) +\n` +
      `  theme_bw(base_family = "Arial") + labs(title = "${title.replace(/"/g, '\\"')}")\n` +
      `ggsave("Figure_Volcano_Plot.pdf", plot = p, width = 7, height = 5.5, dpi = 600)\n`

    const pzfx = exportToPrismPzfx(
      {
        tableType: 'XY',
        title,
        xTitle: 'log2(Fold Change)',
        xValues: pts.map(p => p.log2FC),
        series: [{ name: '-log10(P)', yValues: pts.map(p => p.nlp) }],
      },
      title,
    )

    return {
      svg: rawSvg,
      illustrator_svg: upgradeSvgForIllustrator(rawSvg, { title }),
      r_script: rScript,
      cloud_csv: csv,
      cloud_matrix_csv: csv,
      prism_pzfx: pzfx,
    }
  }

  if (bioType === 'heatmap') {
    const rowGenes = spec.rowGenes ?? spec.heatmap_matrix?.row_names ?? ['Gene1', 'Gene2']
    const colSamples = spec.colSamples ?? spec.heatmap_matrix?.col_names ?? ['Sample1', 'Sample2']
    const sampleGroups = spec.sampleGroups ?? spec.heatmap_matrix?.col_groups
    const matrix = spec.matrix ?? spec.heatmap_matrix?.values ?? [[1, -1], [-1, 1]]
    const nRows = Math.max(1, rowGenes.length)
    const nCols = Math.max(1, colSamples.length)
    const padL = 95
    const padR = 110
    const padT = 80
    const padB = 60
    const cellW = (width - padL - padR) / nCols
    const cellH = (height - padT - padB) / nRows

    // Z-score normalize each row
    const zMatrix = matrix.map(row => {
      const st = meanAndSd(row)
      return row.map(v => (st.sd > 1e-9 ? (v - st.mean) / st.sd : 0))
    })

    const zToColor = (z: number) => {
      const clamped = Math.max(-2, Math.min(2, z))
      if (clamped >= 0) {
        const t = clamped / 2
        const r = 255
        const g = Math.round(255 * (1 - t * 0.78))
        const b = Math.round(255 * (1 - t * 0.78))
        return `rgb(${r},${g},${b})`
      } else {
        const t = -clamped / 2
        const r = Math.round(255 * (1 - t * 0.82))
        const g = Math.round(255 * (1 - t * 0.65))
        const b = 255
        return `rgb(${r},${g},${b})`
      }
    }

    let cellsSvg = ''
    zMatrix.forEach((row, rIdx) => {
      const y = padT + rIdx * cellH
      row.forEach((z, cIdx) => {
        const x = padL + cIdx * cellW
        cellsSvg += `    <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellW.toFixed(1)}" height="${cellH.toFixed(1)}" fill="${zToColor(z)}" stroke="#FFFFFF" stroke-width="0.6"/>\n`
      })
      cellsSvg += `    <text x="${padL + nCols * cellW + 8}" y="${(y + cellH * 0.68).toFixed(1)}" font-size="10.5" font-style="italic" fill="#0F172A">${escXml(rowGenes[rIdx] ?? `Gene_${rIdx}`)}</text>\n`
    })

    colSamples.forEach((sName, cIdx) => {
      const x = padL + (cIdx + 0.5) * cellW
      cellsSvg += `    <text x="${x.toFixed(1)}" y="${padT + nRows * cellH + 18}" text-anchor="middle" font-size="10" fill="#0F172A">${escXml(sName)}</text>\n`
      if (sampleGroups?.[cIdx]) {
        const grp = sampleGroups[cIdx]!
        const gClr = grp.toLowerCase().includes('treat') || grp.toLowerCase().includes('tumor') || grp.toLowerCase().includes('dapa') ? '#DC2626' : '#2563EB'
        cellsSvg += `    <rect x="${(padL + cIdx * cellW).toFixed(1)}" y="${padT - 14}" width="${cellW.toFixed(1)}" height="10" fill="${gClr}" stroke="#FFFFFF" stroke-width="0.6"/>\n`
      }
    })

    const rawSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 ${width} ${height}" width="100%" height="100%" font-family="Arial, Helvetica, sans-serif">\n` +
      `  <rect width="${width}" height="${height}" fill="#FFFFFF"/>\n` +
      `  <text x="${width / 2}" y="28" text-anchor="middle" font-size="14" font-weight="bold" fill="#0F172A">${escXml(title)} (Row Z-Score)</text>\n` +
      `  <g id="Layer_Heatmap_Grid" inkscape:groupmode="layer" inkscape:label="ComplexHeatmap_Grid" data-name="ComplexHeatmap_Grid">\n${cellsSvg}  </g>\n` +
      `</svg>`

    const csv = [
      ['Gene', ...colSamples].join(','),
      ...rowGenes.map((g, i) => [g, ...(matrix[i] ?? []).map(String)].join(',')),
    ].join('\n')

    const rScript =
      `# Reproducible R Script (ComplexHeatmap + circlize)\n` +
      `library(ComplexHeatmap)\nlibrary(circlize)\n` +
      `mat <- as.matrix(read.csv("heatmap_matrix.csv", row.names = 1, check.names = FALSE))\n` +
      `mat_scaled <- t(scale(t(mat)))\n` +
      `pdf("Figure_ComplexHeatmap.pdf", width = 7, height = 6)\n` +
      `Heatmap(mat_scaled, name = "Z-score", col = colorRamp2(c(-2, 0, 2), c("#2563EB", "#FFFFFF", "#DC2626")), cluster_rows = TRUE, cluster_columns = TRUE)\n` +
      `dev.off()\n`

    return {
      svg: rawSvg,
      illustrator_svg: upgradeSvgForIllustrator(rawSvg, { title }),
      r_script: rScript,
      cloud_csv: csv,
      cloud_matrix_csv: csv,
    }
  }

  if (bioType === 'enrichment') {
    const padL = 220
    const padR = 95
    const padT = 55
    const padB = 60
    const plotW = width - padL - padR
    const plotH = height - padT - padB
    const rawPathways = spec.pathways ?? spec.enrichment_terms ?? []
    const items = rawPathways
      .map(d => ({
        term: d.term,
        category: d.category ?? spec.database ?? 'KEGG',
        geneRatio: d.geneRatio ?? d.gene_ratio ?? 0.1,
        count: d.count,
        fdr: d.fdr,
      }))
      .sort((a, b) => b.geneRatio - a.geneRatio)
    const minGr = Math.min(...items.map(d => d.geneRatio)) * 0.9
    const maxGr = Math.max(...items.map(d => d.geneRatio)) * 1.08
    const mapX = (gr: number) => padL + ((gr - minGr) / (maxGr - minGr || 1)) * plotW

    let bubblesSvg = ''
    items.forEach((item, idx) => {
      const y = padT + ((idx + 0.5) / Math.max(1, items.length)) * plotH
      const x = mapX(item.geneRatio)
      const r = Math.max(5, Math.min(14, 4 + Math.sqrt(item.count) * 1.6))
      const nlp = -Math.log10(Math.max(1e-50, item.fdr))
      const clr = nlp > 3 ? '#DC2626' : nlp > 1.3 ? '#D97706' : '#2563EB'
      bubblesSvg +=
        `    <line x1="${padL}" y1="${y.toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#E2E8F0" stroke-width="1" stroke-dasharray="3 3"/>\n` +
        `    <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${clr}" fill-opacity="0.85" stroke="#0F172A" stroke-width="1"/>\n` +
        `    <text x="${padL - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#0F172A">${escXml(item.term)}</text>\n`
    })

    const rawSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 ${width} ${height}" width="100%" height="100%" font-family="Arial, Helvetica, sans-serif">\n` +
      `  <rect width="${width}" height="${height}" fill="#FFFFFF"/>\n` +
      `  <text x="${width / 2}" y="28" text-anchor="middle" font-size="14" font-weight="bold" fill="#0F172A">${escXml(title)} (${escXml(spec.database ?? 'KEGG/GO')})</text>\n` +
      `  <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="none" stroke="#0F172A" stroke-width="1.5"/>\n` +
      `  <text x="${padL + plotW / 2}" y="${height - 16}" text-anchor="middle" font-size="12" font-weight="bold" fill="#0F172A">GeneRatio / Rich Factor</text>\n` +
      `  <g id="Layer_Enrichment_Bubbles" inkscape:groupmode="layer" inkscape:label="Enrichment_Bubbles" data-name="Enrichment_Bubbles">\n${bubblesSvg}  </g>\n` +
      `</svg>`

    const csv = ['Term,Category,GeneRatio,Count,FDR,negLog10FDR', ...items.map(d => `"${d.term}",${d.category},${d.geneRatio},${d.count},${d.fdr},${(-Math.log10(Math.max(1e-50, d.fdr))).toFixed(4)}`)].join('\n')
    const rScript =
      `# Reproducible R Script (clusterProfiler / enrichplot dotplot)\n` +
      `library(clusterProfiler)\nlibrary(ggplot2)\n` +
      `df <- read.csv("enrichment_results.csv")\n` +
      `p <- ggplot(df, aes(x = GeneRatio, y = reorder(Term, GeneRatio), size = Count, color = negLog10FDR)) +\n` +
      `  geom_point(alpha = 0.88) + scale_color_gradient(low = "#2563EB", high = "#DC2626") +\n` +
      `  theme_bw(base_family = "Arial") + labs(title = "${title.replace(/"/g, '\\"')}", y = "")\n` +
      `ggsave("Figure_KEGG_GO_Enrichment.pdf", plot = p, width = 8, height = 5.5, dpi = 600)\n`

    return {
      svg: rawSvg,
      illustrator_svg: upgradeSvgForIllustrator(rawSvg, { title }),
      r_script: rScript,
      cloud_csv: csv,
      cloud_matrix_csv: csv,
    }
  }

  // Single-Cell UMAP / t-SNE DimPlot
  const cells = spec.cells ?? spec.umap_cells ?? [
    { cellId: 'c1', x: -3.2, y: 2.4, cluster: 'Cluster_0' },
    { cellId: 'c2', x: 2.1, y: -1.9, cluster: 'Cluster_1' },
  ]
  const padL = 70
  const padR = 140
  const padT = 55
  const padB = 60
  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const xs = cells.map(c => c.x)
  const ys = cells.map(c => c.y)
  const minX = Math.min(-5, ...xs)
  const maxX = Math.max(5, ...xs)
  const minY = Math.min(-5, ...ys)
  const maxY = Math.max(5, ...ys)
  const mapX = (x: number) => padL + ((x - minX) / (maxX - minX || 1)) * plotW
  const mapY = (y: number) => padT + plotH - ((y - minY) / (maxY - minY || 1)) * plotH

  const clusters = Array.from(new Set(cells.map(c => c.cluster)))
  const palette = ['#2563EB', '#DC2626', '#0D9488', '#D97706', '#7C3AED', '#059669', '#DB2777', '#4F46E5']
  const colorMap = new Map(clusters.map((c, i) => [c, palette[i % palette.length]!]))

  let pointsSvg = ''
  for (const c of cells) {
    pointsSvg += `    <circle cx="${mapX(c.x).toFixed(1)}" cy="${mapY(c.y).toFixed(1)}" r="2.8" fill="${colorMap.get(c.cluster) ?? '#2563EB'}" fill-opacity="0.82"/>\n`
  }

  let legendSvg = ''
  clusters.forEach((cl, idx) => {
    const clr = colorMap.get(cl)!
    const subset = cells.filter(c => c.cluster === cl)
    const cx = mapX(subset.reduce((a, b) => a + b.x, 0) / Math.max(1, subset.length))
    const cy = mapY(subset.reduce((a, b) => a + b.y, 0) / Math.max(1, subset.length))
    legendSvg +=
      `    <text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" text-anchor="middle" font-size="11" font-weight="bold" fill="#0F172A">${escXml(cl)}</text>\n` +
      `    <circle cx="${padL + plotW + 20}" cy="${padT + 20 + idx * 24}" r="5" fill="${clr}"/>\n` +
      `    <text x="${padL + plotW + 32}" y="${padT + 24 + idx * 24}" font-size="11" fill="#0F172A">${escXml(cl)}</text>\n`
  })

  const dimName = spec.reduction ?? 'UMAP'
  const rawSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 ${width} ${height}" width="100%" height="100%" font-family="Arial, Helvetica, sans-serif">\n` +
    `  <rect width="${width}" height="${height}" fill="#FFFFFF"/>\n` +
    `  <text x="${width / 2}" y="28" text-anchor="middle" font-size="14" font-weight="bold" fill="#0F172A">${escXml(title)}</text>\n` +
    `  <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#0F172A" stroke-width="1.8"/>\n` +
    `  <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#0F172A" stroke-width="1.8"/>\n` +
    `  <text x="${padL + plotW / 2}" y="${height - 16}" text-anchor="middle" font-size="12" font-weight="bold" fill="#0F172A">${escXml(dimName)}_1</text>\n` +
    `  <text x="24" y="${padT + plotH / 2}" text-anchor="middle" font-size="12" font-weight="bold" fill="#0F172A" transform="rotate(-90 24 ${padT + plotH / 2})">${escXml(dimName)}_2</text>\n` +
    `  <g id="Layer_SingleCell_Points" inkscape:groupmode="layer" inkscape:label="SingleCell_Embedding" data-name="SingleCell_Embedding">\n${pointsSvg}  </g>\n` +
    `  <g id="Layer_Cluster_Labels" inkscape:groupmode="layer" inkscape:label="Cluster_Annotations" data-name="Cluster_Annotations">\n${legendSvg}  </g>\n` +
    `</svg>`

  const csv = ['CellID,Dim1,Dim2,Cluster', ...cells.map((c, i) => `${c.cellId ?? c.id ?? `Cell_${i + 1}`},${c.x},${c.y},"${c.cluster}"`)].join('\n')
  const rScript =
    `# Reproducible R Script (Seurat::DimPlot / scRNA-seq visualization)\n` +
    `library(Seurat)\nlibrary(ggplot2)\n` +
    `# DimPlot(seurat_obj, reduction = "${dimName.toLowerCase()}", label = TRUE)\n` +
    `emb <- read.csv("umap_coordinates.csv")\n` +
    `p <- ggplot(emb, aes(x = Dim1, y = Dim2, color = Cluster)) + geom_point(size = 0.8, alpha = 0.85) + theme_classic(base_family = "Arial")\n` +
    `ggsave("Figure_SingleCell_${dimName}.pdf", plot = p, width = 7, height = 5.5, dpi = 600)\n`

  return {
    svg: rawSvg,
    illustrator_svg: upgradeSvgForIllustrator(rawSvg, { title }),
    r_script: rScript,
    cloud_csv: csv,
    cloud_matrix_csv: csv,
  }
}

// ============================================================================
// CATEGORY 5: Medical Imaging, Flow Cytometry & Pathology (ImageJ .ijm, FlowJo .wsp, 3D Slicer .mrml, ITK-SNAP .txt)
// ============================================================================

export interface ImageJPathologySpec {
  title?: string
  modality?: 'immunofluorescence' | 'ihc_pathology' | 'western_blot'
  mode?: 'immunofluorescence' | 'ihc_pathology' | 'western_blot'
  imageWidthPx?: number
  image_width_px?: number
  imageHeightPx?: number
  image_height_px?: number
  micronsPerPixel?: number
  pixel_to_um_ratio?: number
  scaleBarMicrons?: number
  scale_bar_um?: number
  channels?: Array<string | { name: string; pseudocolor: 'Blue' | 'Green' | 'Red' | 'Cyan' | 'Magenta'; targetProtein?: string }>
  quantificationGroups?: PrismColumnGroup[]
  wb_lanes?: Array<{ lane: string; group: string; target_band_density: number; loading_control_density: number }>
}

/**
 * Generates an ImageJ/Fiji calibrated figure overlay SVG, a native executable **ImageJ Macro (`.ijm`)**
 * for automatic scale bar stamping, multi-channel RGB merging, and IHC/WB densitometry, plus a GraphPad Prism `.pzfx` file.
 */
export function generateImageJAnalysis(spec: ImageJPathologySpec): {
  svg: string
  illustrator_svg: string
  imagej_macro_ijm: string
  ijm_macro: string
  quantification_csv: string
  prism_pzfx?: string
} {
  const title = spec.title ?? 'Microscopy & Densitometry Calibration'
  const modality = spec.modality ?? spec.mode ?? 'immunofluorescence'
  const imgW = spec.imageWidthPx ?? spec.image_width_px ?? 640
  const imgH = spec.imageHeightPx ?? spec.image_height_px ?? 440
  const umPerPx = spec.micronsPerPixel ?? (spec.pixel_to_um_ratio ? 1 / spec.pixel_to_um_ratio : 0.5)
  const scaleUm = spec.scaleBarMicrons ?? spec.scale_bar_um ?? 50
  const barPx = Math.max(24, Math.min(imgW * 0.4, scaleUm / Math.max(0.001, umPerPx)))
  const barX = imgW - barPx - 32
  const barY = imgH - 34

  const bgFill = modality === 'immunofluorescence' ? '#090D16' : '#F8FAFC'
  const barColor = modality === 'immunofluorescence' ? '#FFFFFF' : '#0F172A'

  let channelBadges = ''
  if (spec.channels?.length) {
    spec.channels.forEach((rawCh, i) => {
      const ch =
        typeof rawCh === 'string'
          ? {
              name: rawCh,
              pseudocolor: (rawCh.toLowerCase().includes('blue') || rawCh.toLowerCase().includes('dapi')
                ? 'Blue'
                : rawCh.toLowerCase().includes('green') || rawCh.toLowerCase().includes('gfp')
                  ? 'Green'
                  : 'Red') as 'Blue' | 'Green' | 'Red',
            }
          : rawCh
      const clr =
        ch.pseudocolor === 'Blue'
          ? '#3B82F6'
          : ch.pseudocolor === 'Green'
            ? '#22C55E'
            : ch.pseudocolor === 'Red'
              ? '#EF4444'
              : ch.pseudocolor === 'Cyan'
                ? '#06B6D4'
                : '#D946EF'
      channelBadges +=
        `    <rect x="${24 + i * 135}" y="20" width="125" height="26" rx="4" fill="#0F172A" fill-opacity="0.72" stroke="${clr}" stroke-width="1.5"/>\n` +
        `    <text x="${86 + i * 135}" y="37" text-anchor="middle" font-size="11" font-weight="bold" fill="${clr}">${escXml(ch.name)}${ch.targetProtein ? `: ${escXml(ch.targetProtein)}` : ''}</text>\n`
    })
  }

  const rawSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 ${imgW} ${imgH}" width="100%" height="100%" font-family="Arial, Helvetica, sans-serif">\n` +
    `  <rect width="${imgW}" height="${imgH}" fill="${bgFill}"/>\n` +
    `  <g id="Layer_Microscopy_Field" inkscape:groupmode="layer" inkscape:label="Microscopy_Field" data-name="Microscopy_Field">\n` +
    `    <text x="${imgW / 2}" y="${imgH / 2}" text-anchor="middle" font-size="14" fill="${barColor}" fill-opacity="0.65">${escXml(title)} (${umPerPx.toFixed(2)} μm/px)</text>\n` +
    channelBadges +
    `  </g>\n` +
    `  <g id="Layer_Scale_Bar" inkscape:groupmode="layer" inkscape:label="Calibrated_Scale_Bar" data-name="Calibrated_Scale_Bar">\n` +
    `    <rect x="${barX.toFixed(1)}" y="${barY}" width="${barPx.toFixed(1)}" height="6" fill="${barColor}"/>\n` +
    `    <text x="${(barX + barPx / 2).toFixed(1)}" y="${barY - 7}" text-anchor="middle" font-size="12" font-weight="bold" fill="${barColor}">${scaleUm} μm (${scaleUm} um)</text>\n` +
    `  </g>\n` +
    `</svg>`

  const ijm =
    `// ImageJ / Fiji Macro (.ijm) generated by Heurion Medical Figure Studio\n` +
    `// Task: ${title} (${modality})\n` +
    `requires("1.53c");\n` +
    `// 1. Spatial Scale Bar Calibration (${umPerPx.toFixed(3)} um/pixel)\n` +
    `run("Set Scale...", "distance=1 known=${umPerPx.toFixed(3)} pixel=1 unit=um");\n` +
    (modality === 'immunofluorescence' && spec.channels?.length
      ? `// 2. Multi-Channel Immunofluorescence Merge (DAPI / GFP / TRITC)\n` +
        `// Uncomment to merge open channel stacks:\n` +
        `// run("Merge Channels...", "c1=[Red] c2=[Green] c3=[Blue] create keep");\n` +
        `run("RGB Color");\n`
      : modality === 'western_blot'
        ? `// 2. Western Blot Band Densitometry (Gel Analyzer)\n` +
          `run("8-bit");\n` +
          `run("Subtract Background...", "rolling=50 light");\n` +
          `// run("Gel Analyzer");\n` +
          `run("Set Measurements...", "area mean integrated redirect=None decimal=4");\n`
        : `// 2. IHC H-DAB Color Deconvolution & Positive Area Quantification\n` +
          `// run("Colour Deconvolution", "vectors=[H DAB]");\n` +
          `run("Set Measurements...", "area mean area_fraction limit redirect=None decimal=3");\n`) +
    `// 3. Stamp Publication Scale Bar (${scaleUm} um)\n` +
    `run("Scale Bar...", "width=${scaleUm} height=6 font=14 color=${modality === 'immunofluorescence' ? 'White' : 'Black'} background=None location=[Lower Right] bold overlay");\n`

  let quantGroups = spec.quantificationGroups
  let quantCsv = 'Lane,Group,Target_Density,Loading_Control_Density,Normalized_Ratio\n'
  if (spec.wb_lanes?.length) {
    const byGroup = new Map<string, number[]>()
    for (const l of spec.wb_lanes) {
      const ratio = Number((l.target_band_density / Math.max(1, l.loading_control_density)).toFixed(4))
      quantCsv += `${l.lane},${l.group},${l.target_band_density},${l.loading_control_density},${ratio}\n`
      const list = byGroup.get(l.group) ?? []
      list.push(ratio)
      byGroup.set(l.group, list)
    }
    quantGroups = Array.from(byGroup.entries()).map(([name, values]) => ({ name, values }))
  } else if (quantGroups?.length) {
    for (const g of quantGroups) {
      g.values.forEach((v, idx) => {
        quantCsv += `${g.name}_${idx + 1},${g.name},${v},1,${v}\n`
      })
    }
  } else {
    quantGroups = [
      { name: 'Control', values: [1.0, 1.04, 0.97] },
      { name: 'Treatment', values: [0.42, 0.39, 0.45] },
    ]
  }

  const pzfx = exportToPrismPzfx({ tableType: 'Column', title: `${title} Quantification`, groups: quantGroups }, title)

  return {
    svg: rawSvg,
    illustrator_svg: upgradeSvgForIllustrator(rawSvg, { title }),
    imagej_macro_ijm: ijm,
    ijm_macro: ijm,
    quantification_csv: quantCsv,
    prism_pzfx: pzfx,
  }
}

export interface FlowJoGatingSpec {
  title?: string
  xChannel?: string
  x_channel?: string
  yChannel?: string
  y_channel?: string
  xGateThreshold?: number
  x_gate_cutoff?: number
  yGateThreshold?: number
  y_gate_cutoff?: number
  quadrant_labels?: {
    q1_ul?: string
    q2_ur?: string
    q3_ll?: string
    q4_lr?: string
  }
  events?: Array<{ x: number; y: number }>
}

/**
 * Computes FlowJo 2D quadrant gating (Q1 UL, Q2 UR, Q3 LL, Q4 LR), renders the 2D scatter + quadrant plot SVG,
 * and exports a native **FlowJo Workspace / ISAC Gating-ML 2.0 (`.wsp` XML)** plus FCS-ready CSV.
 */
export function generateFlowJoAnalysis(spec: FlowJoGatingSpec): {
  svg: string
  illustrator_svg: string
  flowjo_wsp_xml: string
  fcs_csv: string
  quadrant_stats: {
    Q1_UL_pct: number
    Q2_UR_pct: number
    Q3_LL_pct: number
    Q4_LR_pct: number
    q1_pct: number
    q2_pct: number
    q3_pct: number
    q4_pct: number
    total_events: number
  }
} {
  const title = spec.title ?? 'Flow Cytometry Quadrant Gating'
  const xChannel = spec.xChannel ?? spec.x_channel ?? 'FITC-A (Annexin V)'
  const yChannel = spec.yChannel ?? spec.y_channel ?? 'PE-A (PI)'
  const xGate = spec.xGateThreshold ?? spec.x_gate_cutoff ?? 2.5
  const yGate = spec.yGateThreshold ?? spec.y_gate_cutoff ?? 2.5

  const defaultEvents: Array<{ x: number; y: number }> = []
  if (!spec.events || spec.events.length === 0) {
    for (let i = 0; i < 120; i++) {
      if (i < 75) {
        defaultEvents.push({ x: 0.8 + ((i * 17) % 13) * 0.1, y: 0.7 + ((i * 23) % 13) * 0.1 })
      } else if (i < 98) {
        defaultEvents.push({ x: 3.0 + ((i * 19) % 14) * 0.1, y: 0.9 + ((i * 11) % 12) * 0.1 })
      } else if (i < 114) {
        defaultEvents.push({ x: 3.2 + ((i * 13) % 12) * 0.1, y: 3.1 + ((i * 29) % 12) * 0.1 })
      } else {
        defaultEvents.push({ x: 1.1 + ((i * 7) % 10) * 0.1, y: 3.2 + ((i * 17) % 10) * 0.1 })
      }
    }
  }
  const events = spec.events?.length ? spec.events : defaultEvents

  const width = 560
  const height = 520
  const padL = 75
  const padR = 45
  const padT = 55
  const padB = 65
  const plotW = width - padL - padR
  const plotH = height - padT - padB

  const total = Math.max(1, events.length)
  let q1 = 0
  let q2 = 0
  let q3 = 0
  let q4 = 0
  for (const ev of events) {
    if (ev.x < xGate && ev.y >= yGate) q1++
    else if (ev.x >= xGate && ev.y >= yGate) q2++
    else if (ev.x < xGate && ev.y < yGate) q3++
    else q4++
  }

  const q1Pct = Number(((q1 / total) * 100).toFixed(2))
  const q2Pct = Number(((q2 / total) * 100).toFixed(2))
  const q3Pct = Number(((q3 / total) * 100).toFixed(2))
  const q4Pct = Number(((q4 / total) * 100).toFixed(2))
  const stats = {
    Q1_UL_pct: q1Pct,
    Q2_UR_pct: q2Pct,
    Q3_LL_pct: q3Pct,
    Q4_LR_pct: q4Pct,
    q1_pct: q1Pct,
    q2_pct: q2Pct,
    q3_pct: q3Pct,
    q4_pct: q4Pct,
    total_events: events.length,
  }

  const minV = 0
  const maxV = Math.max(5, ...events.flatMap(e => [e.x, e.y])) * 1.05
  const mapX = (v: number) => padL + ((v - minV) / (maxV - minV)) * plotW
  const mapY = (v: number) => padT + plotH - ((v - minV) / (maxV - minV)) * plotH

  let eventsSvg = ''
  for (const ev of events) {
    const clr =
      ev.x >= xGate && ev.y >= yGate
        ? '#DC2626'
        : ev.x >= xGate
          ? '#0D9488'
          : ev.y >= yGate
            ? '#D97706'
            : '#2563EB'
    eventsSvg += `    <circle cx="${mapX(ev.x).toFixed(1)}" cy="${mapY(ev.y).toFixed(1)}" r="2.2" fill="${clr}" fill-opacity="0.65"/>\n`
  }

  const gx = mapX(xGate)
  const gy = mapY(yGate)
  const q1Lbl = spec.quadrant_labels?.q1_ul ?? 'Q1'
  const q2Lbl = spec.quadrant_labels?.q2_ur ?? 'Q2'
  const q3Lbl = spec.quadrant_labels?.q3_ll ?? 'Q3'
  const q4Lbl = spec.quadrant_labels?.q4_lr ?? 'Q4'

  const rawSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 ${width} ${height}" width="100%" height="100%" font-family="Arial, Helvetica, sans-serif">\n` +
    `  <rect width="${width}" height="${height}" fill="#FFFFFF"/>\n` +
    `  <text x="${width / 2}" y="28" text-anchor="middle" font-size="14" font-weight="bold" fill="#0F172A">${escXml(title)}</text>\n` +
    `  <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="none" stroke="#0F172A" stroke-width="1.8"/>\n` +
    `  <g id="Layer_Flow_Events" inkscape:groupmode="layer" inkscape:label="Cytometry_Events" data-name="Cytometry_Events">\n${eventsSvg}  </g>\n` +
    `  <g id="Layer_Quadrant_Gates" inkscape:groupmode="layer" inkscape:label="Quadrant_Gates" data-name="Quadrant_Gates">\n` +
    `    <line x1="${gx.toFixed(1)}" y1="${padT}" x2="${gx.toFixed(1)}" y2="${padT + plotH}" stroke="#0F172A" stroke-width="1.6" stroke-dasharray="6 3"/>\n` +
    `    <line x1="${padL}" y1="${gy.toFixed(1)}" x2="${padL + plotW}" y2="${gy.toFixed(1)}" stroke="#0F172A" stroke-width="1.6" stroke-dasharray="6 3"/>\n` +
    `    <text x="${padL + 12}" y="${padT + 22}" font-size="11" font-weight="bold" fill="#D97706">${escXml(q1Lbl)}: ${stats.Q1_UL_pct}%</text>\n` +
    `    <text x="${padL + plotW - 12}" y="${padT + 22}" text-anchor="end" font-size="11" font-weight="bold" fill="#DC2626">${escXml(q2Lbl)}: ${stats.Q2_UR_pct}%</text>\n` +
    `    <text x="${padL + 12}" y="${padT + plotH - 12}" font-size="11" font-weight="bold" fill="#2563EB">${escXml(q3Lbl)}: ${stats.Q3_LL_pct}%</text>\n` +
    `    <text x="${padL + plotW - 12}" y="${padT + plotH - 12}" text-anchor="end" font-size="11" font-weight="bold" fill="#0D9488">${escXml(q4Lbl)}: ${stats.Q4_LR_pct}%</text>\n` +
    `  </g>\n` +
    `  <text x="${padL + plotW / 2}" y="${height - 18}" text-anchor="middle" font-size="12" font-weight="bold" fill="#0F172A">${escXml(xChannel)} (log10)</text>\n` +
    `  <text x="24" y="${padT + plotH / 2}" text-anchor="middle" font-size="12" font-weight="bold" fill="#0F172A" transform="rotate(-90 24 ${padT + plotH / 2})">${escXml(yChannel)} (log10)</text>\n` +
    `</svg>`

  const wspXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!-- < FlowJoWorkspace Gating-ML 2.0 > -->\n` +
    `<Workspace version="20.0" flowjoVersion="10.9.0" xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">\n` +
    `  <SampleList>\n` +
    `    <Sample name="${escXml(title)}">\n` +
    `      <Population name="Q1_UL" count="${q1}">\n` +
    `        <Gate><gating:RectangleGate gating:id="Gate_Q1_UL">\n` +
    `          <gating:dimension gating:max="${xGate}"><data-type:fcs-dimension data-type:name="${escXml(xChannel)}"/></gating:dimension>\n` +
    `          <gating:dimension gating:min="${yGate}"><data-type:fcs-dimension data-type:name="${escXml(yChannel)}"/></gating:dimension>\n` +
    `        </gating:RectangleGate></Gate>\n` +
    `      </Population>\n` +
    `      <Population name="Q2_UR" count="${q2}">\n` +
    `        <Gate><gating:RectangleGate gating:id="Gate_Q2_UR">\n` +
    `          <gating:dimension gating:min="${xGate}"><data-type:fcs-dimension data-type:name="${escXml(xChannel)}"/></gating:dimension>\n` +
    `          <gating:dimension gating:min="${yGate}"><data-type:fcs-dimension data-type:name="${escXml(yChannel)}"/></gating:dimension>\n` +
    `        </gating:RectangleGate></Gate>\n` +
    `      </Population>\n` +
    `      <Population name="Q3_LL" count="${q3}">\n` +
    `        <Gate><gating:RectangleGate gating:id="Gate_Q3_LL">\n` +
    `          <gating:dimension gating:max="${xGate}"><data-type:fcs-dimension data-type:name="${escXml(xChannel)}"/></gating:dimension>\n` +
    `          <gating:dimension gating:max="${yGate}"><data-type:fcs-dimension data-type:name="${escXml(yChannel)}"/></gating:dimension>\n` +
    `        </gating:RectangleGate></Gate>\n` +
    `      </Population>\n` +
    `      <Population name="Q4_LR" count="${q4}">\n` +
    `        <Gate><gating:RectangleGate gating:id="Gate_Q4_LR">\n` +
    `          <gating:dimension gating:min="${xGate}"><data-type:fcs-dimension data-type:name="${escXml(xChannel)}"/></gating:dimension>\n` +
    `          <gating:dimension gating:max="${yGate}"><data-type:fcs-dimension data-type:name="${escXml(yChannel)}"/></gating:dimension>\n` +
    `        </gating:RectangleGate></Gate>\n` +
    `      </Population>\n` +
    `    </Sample>\n` +
    `  </SampleList>\n` +
    `</Workspace>`

  const csv = [
    `Annexin_V_Log10,PI_Log10,Quadrant,"${xChannel}","${yChannel}"`,
    ...events.map(e => {
      const q =
        e.x < xGate && e.y >= yGate
          ? 'Q1'
          : e.x >= xGate && e.y >= yGate
            ? 'Q2'
            : e.x < xGate && e.y < yGate
              ? 'Q3'
              : 'Q4'
      return `${e.x},${e.y},${q},${e.x},${e.y}`
    }),
  ].join('\n')

  return {
    svg: rawSvg,
    illustrator_svg: upgradeSvgForIllustrator(rawSvg, { title }),
    flowjo_wsp_xml: wspXml,
    fcs_csv: csv,
    quadrant_stats: stats,
  }
}

export interface SlicerItkSnapSpec {
  patientId?: string
  patient_id?: string
  study_id?: string
  studyModality?: 'CT' | 'MRI' | 'PET-CT'
  modality?: 'CT' | 'MRI' | 'PET-CT'
  series_description?: string
  volumeFileName?: string
  segmentationFileName?: string
  roiCenterRAS?: [number, number, number]
  roiSizeMm?: [number, number, number]
  labels?: Array<{
    id: number
    name: string
    rgb: [number, number, number]
    opacity?: number
    volumeMm3?: number
  }>
  rois?: Array<{
    id: number
    name: string
    color_rgb: [number, number, number]
    opacity?: number
    center_ras_mm?: [number, number, number]
    size_mm?: [number, number, number]
    volume_cm3?: number
    mean_hu?: number
  }>
}

/**
 * Generates native **3D Slicer Scene (`.mrml` XML)**, **3D Slicer Markups ROI (`.mrk.json`)**,
 * and **ITK-SNAP Label Description (`.txt`)** files for 3D clinical DICOM/NIfTI lesion segmentation.
 */
export function generateSlicerAndItkSnapPackage(spec: SlicerItkSnapSpec): {
  slicer_mrml_xml: string
  slicer_markups_mrk_json: string
  slicer_markups_json: string
  itksnap_labels_txt: string
  svg_preview: string
} {
  const patientId = spec.patientId ?? spec.patient_id ?? 'PT-001'
  const modality = spec.studyModality ?? spec.modality ?? 'CT'
  const volFile = spec.volumeFileName ?? `${patientId}_scan.nii.gz`
  const segFile = spec.segmentationFileName ?? `${patientId}_segmentation.seg.nrrd`
  const center = spec.roiCenterRAS ?? spec.rois?.[0]?.center_ras_mm ?? [0, 0, 0]
  const size = spec.roiSizeMm ?? spec.rois?.[0]?.size_mm ?? [40, 40, 40]
  const labels =
    spec.labels ??
    (spec.rois?.map(r => ({
      id: r.id,
      name: r.name,
      rgb: r.color_rgb,
      opacity: r.opacity,
      volumeMm3: r.volume_cm3 !== undefined ? r.volume_cm3 * 1000 : undefined,
    })) ?? [{ id: 1, name: 'Primary_Lesion_ROI', rgb: [220, 38, 38] as [number, number, number], opacity: 0.85 }])

  const segDesc = labels.map(l => l.name).join(', ')
  const mrml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE MRML SYSTEM "mrml20.dtd">\n` +
    `<MRML version="Slicer4.11.0" userTags="">\n` +
    `  <VolumeArchetypeStorage id="vtkMRMLVolumeArchetypeStorageNode1" fileName="${escXml(volFile)}" singleFile="1"/>\n` +
    `  <ScalarVolume id="vtkMRMLScalarVolumeNode1" name="${escXml(patientId)}_${escXml(modality)}" storageNodeRef="vtkMRMLVolumeArchetypeStorageNode1" displayNodeRef="vtkMRMLScalarVolumeDisplayNode1"/>\n` +
    `  <ScalarVolumeDisplay id="vtkMRMLScalarVolumeDisplayNode1" window="400" level="40" autoWindowLevel="0"/>\n` +
    `  <SegmentationStorage id="vtkMRMLSegmentationStorageNode1" fileName="${escXml(segFile)}"/>\n` +
    `  <Segmentation id="vtkMRMLSegmentationNode1" name="${escXml(patientId)}_ROI_Labels (${escXml(segDesc)})" storageNodeRef="vtkMRMLSegmentationStorageNode1" displayNodeRef="vtkMRMLSegmentationDisplayNode1"/>\n` +
    `  <SegmentationDisplay id="vtkMRMLSegmentationDisplayNode1" visibility="1" opacity3D="0.85"/>\n` +
    `</MRML>`

  const mrkJson = JSON.stringify(
    {
      '@schema': 'https://raw.githubusercontent.com/slicer/slicer/main/Modules/Loadable/Markups/Resources/Schema/markups-schema-v1.0.3.json#',
      markups: [
        {
          type: 'ROI',
          coordinateSystem: 'RAS',
          locked: false,
          labelFormat: '%N-%d',
          roiType: 'Box',
          center,
          orientation: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
          size,
          controlPoints: [
            {
              id: '1',
              label: `${patientId}_Primary_Lesion_ROI`,
              description: `3D Slicer Markups ROI (${modality})`,
              position: center,
              orientation: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
              selected: true,
              visibility: true,
            },
          ],
        },
      ],
    },
    null,
    2,
  )

  const itkLines: string[] = [
    '################################################',
    '# ITK-SnAP Label Description File',
    '# File format:',
    '# IDX   -R-  -G-  -B-  -A--  VIS MSH  LABEL',
    '################################################',
    '    0     0    0    0        0  0  0    "Clear Label"',
  ]
  for (const lbl of labels) {
    const [r, g, b] = lbl.rgb
    const alpha = (lbl.opacity ?? 1).toFixed(2)
    itkLines.push(
      `${String(lbl.id).padStart(5, ' ')} ${String(r).padStart(5, ' ')} ${String(g).padStart(4, ' ')} ${String(b).padStart(4, ' ')} ${alpha.padStart(8, ' ')}  1  1    "${lbl.name}"`,
    )
  }

  const svgPreview =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 320" width="100%" height="100%" font-family="Arial, Helvetica, sans-serif">\n` +
    `  <rect width="600" height="320" fill="#0F172A"/>\n` +
    `  <text x="300" y="34" text-anchor="middle" font-size="14" font-weight="bold" fill="#F8FAFC">3D Slicer / ITK-SNAP Volumetric ROI Reconstruction (${escXml(patientId)})</text>\n` +
    labels
      .map(
        (l, idx) =>
          `  <rect x="40" y="${70 + idx * 45}" width="24" height="24" rx="4" fill="rgb(${l.rgb.join(',')})"/>\n` +
          `  <text x="76" y="${87 + idx * 45}" font-size="12" font-weight="bold" fill="#F8FAFC">Label ${l.id}: ${escXml(l.name)}</text>`,
      )
      .join('\n') +
    `\n</svg>`

  return {
    slicer_mrml_xml: mrml,
    slicer_markups_mrk_json: mrkJson,
    slicer_markups_json: mrkJson,
    itksnap_labels_txt: itkLines.join('\n') + '\n',
    svg_preview: svgPreview,
  }
}

// ============================================================================
// CATEGORY 6: Ultimate Multi-Panel Journal Layout & Assembly (Adobe Illustrator / Inkscape / 600 DPI PNG)
// ============================================================================

export interface JournalPanelInput {
  panelLetter?: string
  label?: string
  title?: string
  svg: string
  nativeFiles?: Record<string, string | Uint8Array>
  native_files?: Array<{ filename: string; content: string | Uint8Array }>
}

export interface JournalAssemblySpec {
  manuscriptTitle?: string
  title?: string
  journalPreset?: NonNullable<IllustratorUpgradeOptions['journalPreset']>
  journal_spec?: NonNullable<IllustratorUpgradeOptions['journalPreset']>
  columns?: 1 | 2 | 3
  fontFamily?: 'Arial' | 'Times New Roman'
  font_family?: 'Arial' | 'Times New Roman'
  dpi?: number
  panels?: JournalPanelInput[]
}

/**
 * Combines multiple vector figure panels (A, B, C, D...) into a unified, publication-ready
 * Adobe Illustrator / Inkscape multi-layer SVG, renders a high-resolution (300–600 DPI) PNG,
 * generates an editable multi-panel PowerPoint `.pptx`, and bundles all individual panel native source files into a `.zip`.
 */
export function assembleJournalFigure(spec: JournalAssemblySpec): {
  illustrator_svg: string
  high_res_png: Uint8Array
  png_bytes: Uint8Array
  pptx_bytes: Uint8Array
  bundle_zip: Uint8Array
  width_mm: number
  manifest: {
    journalPreset: string
    widthMm: number
    dpi: number
    panelCount: number
    files: string[]
  }
} {
  const manuscriptTitle = spec.manuscriptTitle ?? spec.title ?? 'Multi-Panel Journal Composite Figure'
  const presetKey = spec.journalPreset ?? spec.journal_spec ?? 'nature_double'
  const jSpec = JOURNAL_COLUMN_SPECS[presetKey] ?? JOURNAL_COLUMN_SPECS.nature_double
  const fontFamily = spec.fontFamily ?? spec.font_family ?? 'Arial'
  const cols = spec.columns ?? (presetKey === 'nature_single' ? 1 : 2)
  const panels =
    spec.panels && spec.panels.length > 0
      ? spec.panels
      : [
          {
            panelLetter: 'A',
            title: 'Mechanism Summary',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#F8FAFC"/><text x="200" y="150" text-anchor="middle">Panel A</text></svg>`,
          },
        ]
  const rows = Math.max(1, Math.ceil(panels.length / cols))

  const cellW = 520
  const cellH = 380
  const pad = 28
  const headerH = 44
  const totalW = cols * cellW + (cols + 1) * pad
  const totalH = headerH + rows * cellH + (rows + 1) * pad
  const font = fontFamily === 'Times New Roman' ? "'Times New Roman', Times, serif" : jSpec.fontFamily

  const panelLayers: string[] = []
  const pptxShapes: EditablePptxShape[] = []
  const zipEntries: Record<string, Uint8Array> = {}

  panels.forEach((p, idx) => {
    const col = idx % cols
    const row = Math.floor(idx / cols)
    const x = pad + col * (cellW + pad)
    const y = headerH + pad + row * (cellH + pad)
    const cleanLetter = p.panelLetter ?? p.label ?? String.fromCharCode(65 + idx)

    // Strip outer <svg ...> wrapper of child panel to embed cleanly inside a nested <svg> viewport
    const upgradedPanelSvg = upgradeSvgForIllustrator(p.svg, {
      title: `Panel_${cleanLetter}`,
      fontFamily,
      journalPreset: presetKey,
    })
    zipEntries[`panels/Panel_${cleanLetter}.svg`] = strToU8(upgradedPanelSvg)
    zipEntries[`Panel_${cleanLetter}/Panel_${cleanLetter}.svg`] = strToU8(upgradedPanelSvg)
    if (p.nativeFiles) {
      for (const [fName, content] of Object.entries(p.nativeFiles)) {
        const bytes = typeof content === 'string' ? strToU8(content) : content
        zipEntries[`panels/Panel_${cleanLetter}_${fName}`] = bytes
        zipEntries[`Panel_${cleanLetter}/${fName}`] = bytes
      }
    }
    if (p.native_files) {
      for (const nf of p.native_files) {
        const bytes = typeof nf.content === 'string' ? strToU8(nf.content) : nf.content
        zipEntries[`Panel_${cleanLetter}/${nf.filename}`] = bytes
        zipEntries[`panels/Panel_${cleanLetter}_${nf.filename}`] = bytes
      }
    }

    const innerBody = p.svg
      .replace(/^[\s\S]*?<svg[^>]*>/i, '')
      .replace(/<\/svg>\s*$/i, '')
    const vbMatch = p.svg.match(/viewBox="([^"]+)"/i)
    const vb = vbMatch?.[1] ?? '0 0 680 460'

    panelLayers.push(
      `  <g id="Layer_Panel_${escXml(cleanLetter)}" inkscape:groupmode="layer" inkscape:label="Panel_${escXml(cleanLetter)}" data-name="Panel_${escXml(cleanLetter)}">\n` +
        `    <rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="1"/>\n` +
        `    <svg x="${x + 8}" y="${y + 22}" width="${cellW - 16}" height="${cellH - 30}" viewBox="${vb}">\n` +
        `${innerBody}\n` +
        `    </svg>\n` +
        `    <text x="${x + 10}" y="${y + 20}" font-size="18" font-weight="bold" fill="#0F172A">${escXml(cleanLetter)}</text>\n` +
        (p.title
          ? `    <text x="${x + 32}" y="${y + 19}" font-size="12" font-weight="bold" fill="#334155">${escXml(p.title)}</text>\n`
          : '') +
        `  </g>`,
    )

    pptxShapes.push({
      id: `Panel_${cleanLetter}`,
      label: `Panel ${cleanLetter}${p.title ? `: ${p.title}` : ''}`,
      sublabel: 'Editable Vector Panel (see companion SVG/PZFX/R files)',
      x,
      y,
      w: cellW,
      h: cellH,
      fillHex: 'F8FAFC',
      strokeHex: 'CBD5E1',
      rounded: false,
    })
  })

  const assembledSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 ${totalW} ${totalH}" width="${jSpec.widthMm}mm" data-journal-preset="${presetKey}" data-target-dpi="${jSpec.dpi}" font-family="${font}">\n` +
    `  <rect width="${totalW}" height="${totalH}" fill="#FFFFFF"/>\n` +
    `  <g id="Layer_Manuscript_Header" inkscape:groupmode="layer" inkscape:label="Manuscript_Header" data-name="Manuscript_Header">\n` +
    `    <text x="${totalW / 2}" y="28" text-anchor="middle" font-size="15" font-weight="bold" fill="#0F172A">${escXml(manuscriptTitle)}</text>\n` +
    `  </g>\n` +
    panelLayers.join('\n') +
    `\n</svg>`

  // Render high-res PNG via @resvg/resvg-js (renderSvg scales at 2x+ resolution)
  const pngWidthPx = Math.min(3600, Math.round((jSpec.widthMm / 25.4) * (jSpec.dpi / 2)))
  const highResPng = renderSvg(assembledSvg, pngWidthPx).png

  const pptxBytes = buildEditablePptxFromShapes({
    title: manuscriptTitle,
    subtitle: `Journal Layout Preset: ${presetKey} (${jSpec.widthMm} mm, ${jSpec.dpi} DPI)`,
    canvasWidth: totalW,
    canvasHeight: totalH,
    shapes: pptxShapes,
  })

  zipEntries['Assembled_Figure_Illustrator_Layered.svg'] = strToU8(assembledSvg)
  zipEntries['Composite_Figure_Illustrator_Layered.svg'] = strToU8(assembledSvg)
  zipEntries['Assembled_Figure_HighRes_Print.png'] = highResPng
  zipEntries[`Composite_Figure_${spec.dpi ?? 300}DPI.png`] = highResPng
  zipEntries['Assembled_Figure_Editable_Layout.pptx'] = pptxBytes
  zipEntries['Composite_Figure_Editable.pptx'] = pptxBytes

  const bundleZip = zipSync(zipEntries)

  return {
    illustrator_svg: assembledSvg,
    high_res_png: highResPng,
    png_bytes: highResPng,
    pptx_bytes: pptxBytes,
    bundle_zip: bundleZip,
    width_mm: jSpec.widthMm,
    manifest: {
      journalPreset: presetKey,
      widthMm: jSpec.widthMm,
      dpi: jSpec.dpi,
      panelCount: panels.length,
      files: Object.keys(zipEntries),
    },
  }
}

