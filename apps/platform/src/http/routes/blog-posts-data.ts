/**
 * Heurion Research — Technical Blog & Research Monographs
 * Structured Bilingual Article Data (Heurion 2.0 & Aegis OS)
 */

export type BlogSlug =
  | 'dual-surface-crdt-clinical-ai'
  | 'human-agent-capability-parity-ai-native-software'
  | 'aegis-os-transactional-agent-kernel'
  | 'cross-modal-self-evolution-clinical-deep-review'
  | 'zero-leakage-phi-gatekeeper-and-uomp'
  | 'multi-agent-dogfooding-aegis-os-cow'
  | 'ai-native-document-crdt-publishing'

export const BLOG_SLUGS: readonly BlogSlug[] = [
  'dual-surface-crdt-clinical-ai',
  'human-agent-capability-parity-ai-native-software',
  'aegis-os-transactional-agent-kernel',
  'cross-modal-self-evolution-clinical-deep-review',
  'zero-leakage-phi-gatekeeper-and-uomp',
  'multi-agent-dogfooding-aegis-os-cow',
  'ai-native-document-crdt-publishing',
] as const

export function isBlogSlug(s: string): s is BlogSlug {
  return (BLOG_SLUGS as readonly string[]).includes(s)
}

export type BlogCategory = 'heurion-2' | 'aegis-os' | 'self-evolution' | 'privacy-uomp' | 'omnidoc'

export interface BlogTocItem {
  id: string
  zh: string
  en: string
}

export interface BlogPostMeta {
  slug: BlogSlug
  num: string
  category: BlogCategory
  category_label_zh: string
  category_label_en: string
  date: string
  reading_time_zh: string
  reading_time_en: string
  title_zh: string
  title_en: string
  subtitle_zh: string
  subtitle_en: string
  summary_zh: string
  summary_en: string
  keywords_zh: string
  keywords_en: string
  tags_zh: string[]
  tags_en: string[]
  stats: Array<{ val: string; lbl_zh: string; lbl_en: string }>
  repo_url: string
  paper_url: string
  toc: BlogTocItem[]
  body_zh: string
  body_en: string
}

export const BLOG_POSTS: readonly BlogPostMeta[] = [
  {
    slug: 'dual-surface-crdt-clinical-ai',
    num: '01',
    category: 'heurion-2',
    category_label_zh: 'HEURION · 协同文档架构',
    category_label_en: 'HEURION · DOCUMENT ARCHITECTURE',
    date: '2026-11-04',
    reading_time_zh: '16 分钟深读',
    reading_time_en: '16 min read',
    title_zh: '为什么自由 Shell 智能体在科研论文写作中会失效：双表面 CRDT 与字节级 OOXML 补丁架构',
    title_en: 'Why Free-Form Shell Agents Fail at Research Manuscripts: Dual-Surface CRDT & Byte-Preserving OOXML Patch Architecture',
    subtitle_zh: '告别破坏性整篇覆写与排版坍塌：在单一 ProseMirror + Yjs 真相源上构建人类富文本与智能体结构化原语的对偶投影、Run 级 OOXML 补丁导出与 0.128ms 单轮靶向回滚。',
    subtitle_en: 'Moving beyond destructive full-file overwrites and OOXML drift: dual projection between human WYSIWYG authoring and AI structural primitives, intra-paragraph Run-level OOXML LCS patching, and 0.128ms selective per-turn rollback.',
    summary_zh: '在软件工程中大放异彩的“写 Python 脚本直接改文件”范式，一旦迁移到严肃的学术科研论文（Research Manuscripts, .docx）与学术汇报幻灯片（.pptx）中，就会导致期刊排版坍塌、静默覆盖人类作者的并发修改以及全量重吐带来的 Token 浪费。本文深入剖析 Heurion 的三大底层机制：（1）基于 ProseMirror + Yjs 的双表面对偶投影与 {#id} 块级靶向算子；（2）兼顾块级 Clean Splicing 与段落内 Run 级 LCS 补丁（patchParagraph）的 100% 字节保真 OOXML 导出器；（3）保留人类后续修改的 0.128ms 单轮 AI 靶向回滚（revertByNodes）。',
    summary_en: 'The free-form script-and-overwrite paradigm that excels in software engineering introduces severe failure modes across academic research manuscripts (.docx) and slide decks (.pptx): OOXML formatting destruction, silent overwriting of concurrent co-author edits, and massive token waste. This monograph dissects three foundational mechanisms in Heurion: (1) Dual-Surface CRDT projection with {#id} structural primitives, (2) two-level 100% byte-preserving OOXML splicing and intra-paragraph Run-level LCS patching (patchParagraph), and (3) 0.128ms selective per-turn AI rollback (revertByNodes) with human-priority conflict skipping.',
    keywords_zh: '双表面 CRDT, Yjs, ProseMirror, 科研论文写作, Research Manuscript, OOXML 补丁导出, patchParagraph, revertByNodes, Heurion Research',
    keywords_en: 'Dual-Surface CRDT, Yjs, ProseMirror, Research Manuscript Authoring, OOXML Byte Identity, patchParagraph, revertByNodes, Heurion Research',
    tags_zh: ['双表面 CRDT', 'ProseMirror + Yjs', 'OOXML 100% 保真', '0.128ms 靶向回滚'],
    tags_en: ['Dual-Surface CRDT', 'ProseMirror + Yjs', '100% OOXML Fidelity', '0.128ms Selective Undo'],
    stats: [
      { val: '100%', lbl_zh: '未改段落字节保真', lbl_en: 'Untouched Byte Identity' },
      { val: '0.128ms', lbl_zh: '单轮靶向 CRDT 回滚', lbl_en: 'Selective Turn Rollback' },
      { val: '99.6%', lbl_zh: '输出 Token 节省率', lbl_en: 'Output Token Savings' },
    ],
    repo_url: 'https://github.com/heurion-org/heurion',
    paper_url: 'https://github.com/heurion-org/heurion/blob/main/paper/main.pdf',
    toc: [
      { id: 'sec-paradigm-mismatch', zh: '01. 范式错配：为什么不能让 Agent 写脚本直接改论文文件？', en: '01. The Paradigm Mismatch: Why Script-Based Manuscript Mutation Fails' },
      { id: 'sec-dual-surface', zh: '02. 双表面对偶投影：同一棵 ProseMirror + Yjs 状态树，两套正交视图', en: '02. Dual-Surface Projection: One ProseMirror + Yjs Tree, Two Orthogonal Views' },
      { id: 'sec-ooxml-splice', zh: '03. 100% 字节级 OOXML 树拼接与段落内 Run 级 LCS 补丁（patchParagraph）', en: '03. 100% Byte-Preserving OOXML Splicing & Intra-Paragraph Run-Level LCS Patching' },
      { id: 'sec-selective-undo', zh: '04. 0.128ms 单轮 AI 靶向回滚：块级逆变换与人类修改优先（revertByNodes）', en: '04. 0.128ms Selective Per-Turn Rollback: Block-Indexed Inverse Transforms' },
    ],
    body_zh: `
      <h2 id="sec-paradigm-mismatch">01. 范式错配：为什么不能让 Agent 写脚本直接改论文文件？</h2>
      <p>在过去两年里，以 Claude Code、Cursor 与各类 Coding Agent 为代表的“自由 Shell 执行 + 直接文件改写（Script-and-Audit）”范式在软件工程领域取得了巨大成功。面对纯文本代码（如 TypeScript、Rust 或 Python），Agent 可以随时调用 <code>python3 -c</code> 或正则表达式替换文件，再通过编译器与单元测试兜底。</p>
      <p>然而，当我们把这套“把文档当成平面文件覆写”的范式照搬到<strong>严肃的学术科研手稿（Research Manuscripts）与同行评审论文撰写</strong>——无论是计算机系统、生命科学、物理学还是社会科学——自由脚本范式都会遭遇两道无法逾越的工程鸿沟：</p>
      <ul>
        <li><strong>OOXML 结构坍塌与排版漂移（Formatting Drift）</strong>：全球绝大多数期刊投审稿、基金申请书与跨机构合作重度依赖 Microsoft Word（<code>.docx</code>）与 PowerPoint（<code>.pptx</code>）。一个真实的 <code>.docx</code> 段落内部往往交织着期刊自定义样式（<code>w:pStyle</code>）、原生数学公式（<code>m:oMath</code>）、复杂交叉引用域（<code>w:fldChar</code> begin/separate/end）、书签范围以及合著者的修订留痕（<code>w:ins</code> / <code>w:del</code>）。当 Agent 使用 <code>python-docx</code> 或 Pandoc 重新序列化文档时，模型无法理解的 XML 子树会被大面积剥离或重置。</li>
        <li><strong>人机并发共编时的静默覆写与全量重吐浪费</strong>：科研人员在审阅 AI 初稿时往往会边读边改。基于文件覆写的 Agent 在长耗时推理（30–90 秒）结束后将文件写回磁盘时，会直接冲掉人类作者在此期间做出的全部手动修改；更糟糕的是，为了改一个 40 字的段落而让大模型重吐整篇 6,000 字的 Markdown，不仅浪费 99% 以上的输出 Token，还让“仅撤回上一轮 AI 修改但保留人类后续打字”变得不可能。</li>
      </ul>

      <div class="blog-callout">
        <div class="blog-callout-title">核心设计公理（Design Axiom）</div>
        <p>在高严肃度科研与长文档工程中，<strong>永远不要把原始文件（Raw File）暴露给自治智能体直接覆写</strong>。必须将论文手稿抽象为带生命周期稳定寻址（<code>{#id}</code>）的确定性状态机（CRDT），在内存中以结构化算子完成精准局部修改，并在导出时对底层 OOXML 执行最小颗粒度的字节补丁。</p>
      </div>

      <h2 id="sec-dual-surface">02. 双表面对偶投影：同一棵 ProseMirror + Yjs 状态树，两套正交视图</h2>
      <p>为了同时满足“人类需要所见即所得的富文本与多人实时协同”与“大模型需要高信噪比、低 Token 开销的确定性块寻址”，我们在单一 <strong>ProseMirror + Yjs CRDT</strong> 状态树之上构建了<strong>双表面对偶投影（Dual-Surface Projection）</strong>：</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 290" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="双表面对偶投影数据流与块级寻址架构图">
          <rect x="1" y="1" width="758" height="288" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Left: Human Surface -->
          <rect x="22" y="24" width="212" height="164" fill="#F2EFE9" stroke="#C8C1B4" stroke-width="1"/>
          <text x="128" y="46" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">HUMAN SURFACE · WYSIWYG</text>
          <line x1="22" y1="56" x2="234" y2="56" stroke="#DFDAD0"/>
          <text x="128" y="80" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="11" font-weight="600">富文本手稿 &amp; 幻灯片画布</text>
          <text x="36" y="104" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• y-prosemirror 实时协同</text>
          <text x="36" y="124" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• 隐藏底层 {#id} 与 XML 属性</text>
          <text x="36" y="144" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• 产生 userEditedIds 实时锁</text>
          <text x="36" y="164" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9">• 行内锚定批注线程 {#c:id}</text>

          <!-- Center: Single CRDT Truth -->
          <rect x="274" y="24" width="212" height="164" fill="#233E33" stroke="#151C19" stroke-width="1"/>
          <text x="380" y="46" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">SINGLE CRDT STATE MACHINE</text>
          <line x1="274" y1="56" x2="486" y2="56" stroke="#395A4C"/>
          <text x="380" y="80" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="11" font-weight="600">ProseMirror PMNode + Y.Doc</text>
          <text x="288" y="104" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="9">• 块级稳定属性 attrs.id = "p8f2"</text>
          <text x="288" y="124" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="9">• O(1) 哈希索引 indexById(doc)</text>
          <text x="288" y="144" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="9">• 行内原子 citation / word_inline</text>
          <text x="288" y="164" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9">• Turn 前后快照 base / current</text>

          <!-- Right: Agent Surface -->
          <rect x="526" y="24" width="212" height="164" fill="#F2EFE9" stroke="#C8C1B4" stroke-width="1"/>
          <text x="632" y="46" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">AGENT SURFACE · ANNOTATED MD</text>
          <line x1="526" y1="56" x2="738" y2="56" stroke="#DFDAD0"/>
          <text x="632" y="80" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="11" font-weight="600">紧凑结构投影 &amp; 算子接口</text>
          <text x="540" y="104" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• serializeBlock(n, {ids:true})</text>
          <text x="540" y="124" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• 仅暴露 {#id} + Markdown 语义</text>
          <text x="540" y="144" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• applyOps(): 6 类靶向修改算子</text>
          <text x="540" y="164" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9">• 节省 99.6% 单轮输出 Token</text>

          <line x1="234" y1="106" x2="274" y2="106" stroke="#233E33" stroke-width="1.5"/>
          <line x1="486" y1="106" x2="526" y2="106" stroke="#8F5638" stroke-width="1.5"/>

          <!-- Bottom: Exporter & Revert -->
          <rect x="22" y="212" width="346" height="54" fill="#EFECE4" stroke="#C8C1B4"/>
          <text x="195" y="234" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">OOXML PATCH EXPORTER (patchParagraph)</text>
          <text x="195" y="252" text-anchor="middle" fill="#4A534E" font-family="Inter, sans-serif" font-size="9.5">Clean 块字节级直拼 + Dirty 块段落内 Run 级 LCS 补丁</text>

          <rect x="392" y="212" width="346" height="54" fill="#EFECE4" stroke="#C8C1B4"/>
          <text x="565" y="234" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">SELECTIVE TURN REVERT (revertByNodes)</text>
          <text x="565" y="252" text-anchor="middle" fill="#4A534E" font-family="Inter, sans-serif" font-size="9.5">0.128ms 逆向恢复 AI 修改块，自动跳过 userTouched 块</text>

          <line x1="330" y1="188" x2="195" y2="212" stroke="#233E33" stroke-width="1.2"/>
          <line x1="430" y1="188" x2="565" y2="212" stroke="#233E33" stroke-width="1.2"/>
        </svg>
        <figcaption>图 1：双表面 CRDT 对偶投影（Human Surface vs. Agent Surface）及其与底层 OOXML 补丁导出器、单轮逆向回滚器的协同关系。</figcaption>
      </figure>

      <h3>2.1 内部状态树与两套表面的具体编码对比</h3>
      <p>在底层文档模型的 Schema 定义中，每一个可寻址节点（<code>heading</code>、<code>paragraph</code>、<code>table</code>、<code>figure</code>）都在其属性字典中持有一个跨编辑周期恒定的短 ID（由字母前缀加无碰撞伪随机字符组成，例如 <code>h3a1</code>、<code>p8f2</code>、<code>tbl1</code>）。而在段落内部，文献引用（<code>citation</code>）、动态统计测量值（<code>measurement</code>）与不可拆解的原生 Word 对象（<code>word_inline</code>，如 OMML 公式或复杂域）均被建模为<strong>行内不可分割原子节点（Inline Leaf Atoms）</strong>。</p>
      <p>下面展示同一个段落节点在三层空间中的精确形态：</p>
      <pre><code>// (A) 内存中的 ProseMirror + Yjs 状态树节点 (PMNode JSON)
{
  "type": "paragraph",
  "attrs": { "id": "p8f2", "style": "Normal", "align": "justify" },
  "content": [
    { "type": "text", "text": "Primary endpoint events occurred in 16.3% vs. 21.2% of subjects (" },
    { "type": "measurement", "attrs": { "m_id": "m_hr01" } },
    { "type": "text", "text": "; P &lt; 0.001) " },
    { "type": "citation", "attrs": { "cite_id": "ref_2019" } },
    { "type": "text", "text": "." }
  ]
}</code></pre>
      <p>当智能体调用 <code>doc_read</code> 读取该章节时，结构化投影函数 <code>serializeBlock(node, { ids: true })</code> 将其无损投射为紧凑的 <strong>Agent Surface（带块级锚点与行内评论的扩展 Markdown）</strong>：</p>
      <pre><code>{#h3a1} ## 3. Primary Efficacy Outcomes

{#p8f2} Primary endpoint events occurred in 16.3% vs. 21.2% of subjects ([m:m_hr01]; P &lt; 0.001) [@ref_2019].
  &gt; [Comment {#c:rev1}]: 请补充次要终点住院率的风险比说明。

{#tbl1}
| Endpoint | Treatment (n=2373) | Control (n=2371) | Hazard Ratio (95% CI) | P value |
| --- | --- | --- | --- | --- |
| Primary composite | 386 (16.3%) | 502 (21.2%) | 0.74 (0.65–0.85) | &lt;0.001 |</code></pre>

      <h3>2.2 结构化修改算子（<code>applyOps</code>）与 <code>userEditedIds</code> 实时防撞</h3>
      <p>当智能体根据上述批注 <code>{#c:rev1}</code> 修改段落 <code>{#p8f2}</code> 时，它<strong>不需要重吐整个章节或表格</strong>，只需向算子执行器 <code>applyOps(doc, ops, { taken, userEditedIds })</code> 发送一条仅 20 余个 Token 的类型化指令：</p>
      <pre><code>// 智能体发出的结构化算子 (DocOp)
{
  "op": "replace_text",
  "scope": "p8f2",
  "find": "([m:m_hr01]; P &lt; 0.001) [@ref_2019].",
  "replace": "([m:m_hr01]; P &lt; 0.001) [@ref_2019], driven by a 30% reduction in recurrent hospitalizations."
}</code></pre>
      <p>在 <code>applyOps</code> 内部，算子执行器通过以下三步保证绝对的确定性：</p>
      <ol>
        <li><strong>$O(1)$ 块寻址与跨格式范围定位</strong>：通过 <code>indexById(tr.doc).get("p8f2")</code> 直接定位目标块在文档树中的精确偏移量 <code>pos</code>，并在块内构建展平文本切片（将 <code>citation</code> 映射为 <code>[@cite_id]</code>、<code>measurement</code> 映射为 <code>[m:m_id]</code>），使得 <code>find</code> 即使跨越粗体、斜体或行内引用标记也能精确命中对应的 ProseMirror 坐标区间 <code>[from, to]</code>。</li>
        <li><strong>行内格式自动继承（Inherited Marks）</strong>：当用新文本替换原区间时，<code>replace_text</code> 自动读取被替换首字符的样式标记（<code>inheritedMarks</code>，如原有的字体、字号或超链接），让 AI 改写后的文字天然融入周围排版。</li>
        <li><strong>人类编辑行级锁（<code>userEditedIds</code>）</strong>：若在 AI 思考期间，人类作者正在前端编辑器中手动修改 <code>{#p8f2}</code>，前端协同网关会将 <code>"p8f2"</code> 标记进当前回合的 <code>userEditedIds</code> 集合。此时任何试图覆写该块的 AI 算子都会在 <strong>&lt;0.2 ms</strong> 内被拒绝并抛出 <code>USER_EDITED_CONFLICT</code>，彻底杜绝静默覆写。</li>
      </ol>

      <h2 id="sec-ooxml-splice">03. 100% 字节级 OOXML 树拼接与段落内 Run 级 LCS 补丁（<code>patchParagraph</code>）</h2>
      <p>双表面 CRDT 解决了内存中的协同问题，但科研论文最终必须交付为期刊系统要求的 <code>.docx</code> 文件。如果导出 <code>.docx</code> 时把内存里的 ProseMirror 树简单地全量序列化成新的 XML，那么原文档里那些 ProseMirror 模型无法完备表达的复杂 Word 特性——如期刊页眉页脚、奇偶页分节符、OMML 数学公式（<code>&lt;m:oMath&gt;</code>）、EndNote/Zotero 复杂域代码（<code>w:fldChar</code>）、书签（<code>w:bookmarkStart</code>）以及合作者留下的修订留痕（<code>&lt;w:ins&gt;</code>）——就会在一次导入导出后荡然无存。</p>
      <p>为此，我们在底层文档引擎中实现了一套<strong>两级字节保真 OOXML 补丁导出架构（Two-Level Byte-Preserving OOXML Patch Exporter）</strong>：</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 270" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="两级 OOXML 字节级树拼接与段落内 Run 级补丁流水线">
          <rect x="1" y="1" width="758" height="268" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Input -->
          <rect x="20" y="34" width="168" height="202" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="104" y="58" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">IMPORTED .DOCX</text>
          <line x1="20" y1="68" x2="188" y2="68" stroke="#DFDAD0"/>
          <text x="32" y="92" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.5">1. 原字节包 zipArchive</text>
          <text x="32" y="114" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.5">2. 块级原始 XML 字典:</text>
          <text x="38" y="132" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">rawXmlById.get("p8f2")</text>
          <text x="32" y="156" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.5">3. 导入基线快照:</text>
          <text x="38" y="174" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">beforeNode.get("p8f2")</text>
          <text x="32" y="200" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.5">4. 现态节点 afterNode</text>

          <line x1="188" y1="95" x2="226" y2="72" stroke="#233E33" stroke-width="1.4"/>
          <line x1="188" y1="165" x2="226" y2="185" stroke="#8F5638" stroke-width="1.4"/>

          <!-- Level 1: Clean Node -->
          <rect x="226" y="28" width="290" height="82" fill="#E3ECE7" stroke="#233E33"/>
          <text x="371" y="50" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">LEVEL 1 · CLEAN BLOCK (after.eq(before))</text>
          <text x="371" y="72" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">未修改块：100% 原始 XML 字节流直拼</text>
          <text x="371" y="92" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">outXml += rawXmlById.get(id) // 零解析损耗</text>

          <!-- Level 2: Dirty Node -->
          <rect x="226" y="128" width="290" height="114" fill="#233E33" stroke="#151C19"/>
          <text x="371" y="150" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">LEVEL 2 · DIRTY BLOCK (patchParagraph)</text>
          <text x="240" y="172" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.5">• 拆解原 &lt;w:p&gt; 为 RNode 树 (keep/atom/box/run)</text>
          <text x="240" y="191" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.5">• 字符+样式签名 LCS 对齐 align(old, now)</text>
          <text x="240" y="210" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.5">• 原样保留 m:oMath 公式、w:fldChar 域、书签</text>
          <text x="240" y="229" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.5">• 冻结他人修订容器 &lt;w:ins&gt; (frozen: true)</text>

          <line x1="516" y1="69" x2="554" y2="115" stroke="#233E33" stroke-width="1.4"/>
          <line x1="516" y1="185" x2="554" y2="145" stroke="#233E33" stroke-width="1.4"/>

          <!-- Output -->
          <rect x="554" y="64" width="184" height="142" fill="#EFECE4" stroke="#151C19"/>
          <text x="646" y="92" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">EXPORTED .DOCX</text>
          <line x1="554" y1="102" x2="738" y2="102" stroke="#C8C1B4"/>
          <text x="646" y="126" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• 未动块 100.0% 字节恒等</text>
          <text x="646" y="148" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• 改动块内公式/域零丢失</text>
          <text x="646" y="170" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.8" font-weight="600">• 合作者修订归属不串味</text>
        </svg>
        <figcaption>图 2：两级 OOXML 导出流水线——块级 Clean Splicing 与段落内 Run 级最小差分补丁（<code>patchParagraph</code>）。</figcaption>
      </figure>

      <h3>3.1 第一级：未修改块（Clean Node）的 100% 原始字节流直拼</h3>
      <p>当一份 <code>.docx</code> 被导入时，解析器不仅生成 ProseMirror 节点，还将原始 <code>word/document.xml</code> 中每个顶级块（<code>&lt;w:p&gt;</code>、<code>&lt;w:tbl&gt;</code>）的原始 XML 字符串按块 ID <code>{#id}</code> 缓存在原件映射表中，并保存导入时刻的基线模型快照 <code>before</code>。导出时，只要某个块满足 <code>after.eq(before)</code>（即人机均未修改该段），导出器直接将该块对应的原始 XML 字节切片原封不动地写回 <code>word/document.xml</code>。这意味着整篇论文中 95% 未被触碰的段落与原文件实现<strong>严格的 100.0% 字节恒等（Byte-Identical）</strong>。</p>

      <h3>3.2 第二级：已修改块（Dirty Node）的段落内 Run 级 LCS 补丁算法</h3>
      <p>更具挑战性的问题是：<strong>如果某个段落内部既包含复杂的 Word 原生数学公式（<code>&lt;m:oMath&gt;</code>）、书签和合作者的 Track Changes 修订（<code>&lt;w:ins w:author="Co-Author"&gt;</code>），而 AI 恰好调用 <code>replace_text</code> 改了这同一段里的几个词，怎么保住该段内其余的复杂 XML？</strong></p>
      <p>在段落内补丁导出器中，<code>patchParagraph(raw, before, after, render)</code> 实现了一套精巧的<strong>段落内 Run 级最小补丁算法</strong>：</p>
      <ol>
        <li><strong>将原段落 XML 解析为四类结构节点（<code>RNode</code>）</strong>：
          <ul>
            <li><code>keep</code>：非文本控制节点（如段落属性 <code>&lt;w:pPr&gt;</code>、书签起止 <code>&lt;w:bookmarkStart/&gt;</code>、批注范围标记），无条件原样保留；</li>
            <li><code>atom</code>：复杂域（从 <code>w:fldCharType="begin"</code> 到配对的 <code>end</code> 跨多个兄弟元素打包为一个原子）、原生数学公式（<code>&lt;m:oMath&gt;</code>）与脚注引用（<code>&lt;w:footnoteReference&gt;</code>）；</li>
            <li><code>box</code>：超链接（<code>&lt;w:hyperlink&gt;</code>）、内容控件（<code>&lt;w:sdt&gt;</code>）以及<strong>冻结修订容器（<code>&lt;w:ins&gt;</code> / <code>&lt;w:moveTo&gt;</code>，标记为 <code>frozen: true</code>）</strong>；</li>
            <li><code>run</code>：普通文本运行（<code>&lt;w:r&gt;</code>），拆分为样式属性 <code>rPr</code> 与字符序列 <code>parts</code>。</li>
          </ul>
        </li>
        <li><strong>带格式签名的字符级 LCS 对齐与语义清理（Semantic Cleanup）</strong>：算法将导入时的模型 <code>before</code> 与当前模型 <code>after</code> 分别展开为带格式签名的记号序列 <code>sig = ch + "|" + markSig</code>，运行最长公共子序列（LCS）动态规划 <code>align(old, now)</code>，并执行类似 <code>diff-match-patch</code> 的语义清理（将夹在两处大改动之间的零碎短匹配并入改动区，防止把一个英文单词拆得支离破碎）。</li>
        <li><strong>最小侵入式写回与修订容器冻结保护</strong>：
          <ul>
            <li>若某个原始 <code>&lt;w:t&gt;</code> 内的所有字符在 <code>keep[]</code> 中均为 <code>true</code> 且无新字符插入，直接输出原 <code>&lt;w:t&gt;</code> 原始 XML；</li>
            <li>若在某个 <code>&lt;w:r&gt;</code> 中插入了相同格式的新文字，直接写进当前 run（并自动剥离旧的加粗/斜体增量后继承原 run 的字体、字号、语言等底层 <code>w:rPr</code> 属性，效果等同于人类直接在 Word 中打字）；</li>
            <li>对于 <code>frozen: true</code> 的合作者修订容器（<code>&lt;w:ins&gt;</code>），算法强制校验容器内字符未被篡改，并将紧贴容器边界的新增文字精准排斥在 <code>&lt;/w:ins&gt;</code> 容器之外——<strong>绝不把 AI 新增的文字伪造成合作者的修订记录</strong>。</li>
          </ul>
        </li>
      </ol>

      <pre><code>&lt;!-- 补丁前：原段落包含期刊自定义样式、合作者修订 &lt;w:ins&gt; 与原生 OMML 公式 --&gt;
&lt;w:p w14:paraId="3A8F12B0"&gt;
  &lt;w:pPr&gt;&lt;w:pStyle w:val="JournalBody"/&gt;&lt;/w:pPr&gt;
  &lt;w:bookmarkStart w:id="0" w:name="_Ref1042"/&gt;
  &lt;w:r&gt;&lt;w:rPr&gt;&lt;w:rFonts w:ascii="Times New Roman"/&gt;&lt;/w:rPr&gt;&lt;w:t&gt;The estimator converges at rate &lt;/w:t&gt;&lt;/w:r&gt;
  &lt;m:oMath&gt;&lt;m:r&gt;&lt;m:t&gt;O(n^{-1/2})&lt;/m:t&gt;&lt;/m:r&gt;&lt;/m:oMath&gt;
  &lt;w:ins w:id="4" w:author="CoAuthor"&gt;
    &lt;w:r&gt;&lt;w:t&gt; under weak regularity&lt;/w:t&gt;&lt;/w:r&gt;
  &lt;/w:ins&gt;
  &lt;w:r&gt;&lt;w:rPr&gt;&lt;w:rFonts w:ascii="Times New Roman"/&gt;&lt;/w:rPr&gt;&lt;w:t&gt; in our simulation.&lt;/w:t&gt;&lt;/w:r&gt;
  &lt;w:bookmarkEnd w:id="0"/&gt;
&lt;/w:p&gt;

&lt;!-- 经 AI replace_text("in our simulation.", "across all 1,000 Monte Carlo replications.") 后，
     patchParagraph() 导出的 XML：w14:paraId、pStyle、书签、m:oMath 公式与 CoAuthor 修订 100% 完好保留！ --&gt;
&lt;w:p w14:paraId="3A8F12B0"&gt;
  &lt;w:pPr&gt;&lt;w:pStyle w:val="JournalBody"/&gt;&lt;/w:pPr&gt;
  &lt;w:bookmarkStart w:id="0" w:name="_Ref1042"/&gt;
  &lt;w:r&gt;&lt;w:rPr&gt;&lt;w:rFonts w:ascii="Times New Roman"/&gt;&lt;/w:rPr&gt;&lt;w:t&gt;The estimator converges at rate &lt;/w:t&gt;&lt;/w:r&gt;
  &lt;m:oMath&gt;&lt;m:r&gt;&lt;m:t&gt;O(n^{-1/2})&lt;/m:t&gt;&lt;/m:r&gt;&lt;/m:oMath&gt;
  &lt;w:ins w:id="4" w:author="CoAuthor"&gt;
    &lt;w:r&gt;&lt;w:t&gt; under weak regularity&lt;/w:t&gt;&lt;/w:r&gt;
  &lt;/w:ins&gt;
  &lt;w:r&gt;&lt;w:rPr&gt;&lt;w:rFonts w:ascii="Times New Roman"/&gt;&lt;/w:rPr&gt;&lt;w:t xml:space="preserve"&gt; across all 1,000 Monte Carlo replications.&lt;/w:t&gt;&lt;/w:r&gt;
  &lt;w:bookmarkEnd w:id="0"/&gt;
&lt;/w:p&gt;</code></pre>

      <h2 id="sec-selective-undo">04. 0.128ms 单轮 AI 靶向回滚：块级逆变换与人类修改优先（<code>revertByNodes</code>）</h2>
      <p>在真实科研写作中，一个常见场景是：AI 在第 $T_1$ 回合修改了 <code>{#p01}</code>、<code>{#p02}</code> 并新增了 <code>{#p03}</code>；随后人类作者在第 $T_2$ 时刻顺手润色了 <code>{#p02}</code> 并在 <code>{#p09}</code> 写下了新的结论；到了第 $T_3$ 时刻，作者决定<strong>“撤回第 $T_1$ 回合的 AI 修改”</strong>。</p>
      <p>如果是传统的线性 Undo 栈或 Git Revert，撤回 $T_1$ 要么会连带把人类在 $T_2$ 对 <code>{#p02}</code> 和 <code>{#p09}</code> 的修改一起冲掉，要么直接报合并冲突失败。而在块级逆变换引擎中，我们利用块级寻址实现了延迟仅 <strong>0.128 ms</strong>、且严格遵循<strong>“人类修改绝对优先（Human-Edits-Win）”</strong>的靶向回滚函数 <code>revertByNodes(current, base, changes, userTouched)</code>：</p>

      <pre><code>// 单轮块级靶向回滚核心算法精简展示
export function revertByNodes(
  current: PMNode,
  base: PMNode,
  changes: Array&lt;{ node_id: string; kind: 'added' | 'modified' | 'removed' }&gt;,
  userTouched: Set&lt;string&gt;,
): { doc: PMNode; skipped: string[] } {
  const baseIndex = indexById(base)
  const ids = new Set(changes.map(c =&gt; c.node_id))
  const skipped: string[] = []
  const tr = new Transform(current)

  for (const id of ids) {
    // 1. 人类在该回合之后改过的块直接跳过（人类修改优先，绝不倒退人类工作）
    if (userTouched.has(id)) { skipped.push(id); continue }
    const now = indexById(tr.doc).get(id)
    const before = baseIndex.get(id)

    if (now &amp;&amp; !before) {
      // 2. 该回合 AI 新增的块 (#p03) → 精准删除该块区间
      tr.delete(now.pos, now.pos + now.node.nodeSize)
    } else if (now &amp;&amp; before &amp;&amp; !now.node.eq(before.node)) {
      // 3. 该回合 AI 修改过且人类未再触碰的块 (#p01) → 换回回合前基线节点 before.node
      tr.replaceWith(now.pos, now.pos + now.node.nodeSize, before.node)
    }
  }
  // 4. 该回合被 AI 删除的块 → 寻址原前序兄弟锚点 (anchor.pos + anchor.node.nodeSize) 原位放回
  return { doc: tr.doc, skipped }
}</code></pre>

      <p>回到刚才的例子：执行 <code>revertByNodes</code> 后，<code>{#p01}</code> 瞬间恢复为 $T_1$ 之前的原貌，AI 新增的 <code>{#p03}</code> 被干净移除，而人类在 $T_2$ 亲手润色过的 <code>{#p02}</code>（在 <code>skipped</code> 列表中返回提示）与 <code>{#p09}</code> 则完好无损地保留在文档中。</p>

      <h3>4.1 综合性能与保真度实测对比</h3>
      <div class="blog-table-wrap">
        <table class="blog-table">
          <thead>
            <tr>
              <th>评测维度 (Metric)</th>
              <th>自由脚本覆写 (python-docx / Bash)</th>
              <th>全量 Markdown 重写基线</th>
              <th>Heurion 双表面 CRDT + OOXML Patch</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>未修改 OOXML 节点字节保留率</td>
              <td>31.4%（样式/域代码漂移）</td>
              <td>0.0%（全量重生成）</td>
              <td><strong>100.0% (Byte-Identical)</strong></td>
            </tr>
            <tr>
              <td>修改段落内公式 (<code>m:oMath</code>) 与他人修订保留率</td>
              <td>0.0%（重写段落时丢失）</td>
              <td>0.0%（Markdown 无此语义）</td>
              <td><strong>100.0% (Run 级 LCS 补丁)</strong></td>
            </tr>
            <tr>
              <td>人机并发编辑防覆写保护</td>
              <td>0.0%（静默覆盖人工修改）</td>
              <td>0.0%（整篇替换）</td>
              <td><strong>100.0% (<code>userEditedIds</code> 块锁)</strong></td>
            </tr>
            <tr>
              <td>局部修订单次输出 Token 消耗</td>
              <td>~1,850 tokens (脚本生成)</td>
              <td>~6,400 tokens (整篇重吐)</td>
              <td><strong>~26 tokens (-99.6%)</strong></td>
            </tr>
            <tr>
              <td>跨人类编辑后的单轮 AI 靶向回滚耗时</td>
              <td>不支持（需整文件还原）</td>
              <td>不支持（连带冲掉人工修改）</td>
              <td><strong>0.128 ms (<code>revertByNodes</code>)</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>通过将<strong>双表面 CRDT 投影</strong>、<strong>段落内 Run 级 OOXML 补丁导出</strong>与<strong>块级靶向逆变换</strong>三者闭环结合，我们第一次让自治智能体具备了在不破坏任何原始排版与人类协作心血的前提下，深度参与严肃学术手稿共编的底层工程能力。</p>
    `,
    body_en: `
      <h2 id="sec-paradigm-mismatch">01. The Paradigm Mismatch: Why Script-Based Manuscript Mutation Fails</h2>
      <p>Over the past two years, the "free-form shell execution and direct file manipulation" (Script-and-Audit) paradigm—pioneered by coding agents such as Claude Code and Cursor—has achieved remarkable success in software engineering. When operating on plain-text source files (TypeScript, Rust, Python), an agent can invoke <code>python3 -c</code> or regular expressions to rewrite files and rely on compilers and test suites as a safety net.</p>
      <p>However, transplanting this file-overwrite paradigm into <strong>academic research manuscripts and peer-reviewed scientific publishing</strong>—across computer science, life sciences, physics, and economics—hits two fundamental systems barriers:</p>
      <ul>
        <li><strong>Destructive OOXML Formatting Drift</strong>: Academic journals, grant agencies, and multi-institutional collaborations rely heavily on Microsoft Word (<code>.docx</code>) and PowerPoint (<code>.pptx</code>). A single <code>.docx</code> paragraph frequently interleaves custom journal styles (<code>w:pStyle</code>), native OMML mathematical equations (<code>m:oMath</code>), multi-run complex fields (<code>w:fldChar</code> begin/separate/end for EndNote/Zotero citations), bookmark ranges, and co-author Track Changes (<code>w:ins</code> / <code>w:del</code>). When an agent re-serializes a document via <code>python-docx</code> or Pandoc, XML subtrees outside its simplified object model are silently stripped or corrupted.</li>
        <li><strong>Silent Overwrites &amp; Full-File Token Waste</strong>: Researchers routinely edit sections of a manuscript while an AI agent is reasoning in the background (30–90 seconds). File-level script overwrites blindly clobber every human edit made during the agent turn. Moreover, re-emitting a 6,000-word manuscript just to refine a 40-word paragraph wastes over 99% of output tokens and makes it impossible to selectively undo an AI turn without wiping out subsequent human typing.</li>
      </ul>

      <div class="blog-callout">
        <div class="blog-callout-title">Core Design Axiom</div>
        <p>In high-stakes scientific and academic authoring, <strong>never expose raw document files to autonomous agents for direct file-level overwrite</strong>. Represent the manuscript as a deterministic CRDT state machine with lifecycle-stable block addressing (<code>{#id}</code>), execute localized structural primitives in memory, and apply minimal Run-level XML patches during OOXML export.</p>
      </div>

      <h2 id="sec-dual-surface">02. Dual-Surface Projection: One ProseMirror + Yjs Tree, Two Orthogonal Views</h2>
      <p>To satisfy both human co-authors (who need rich WYSIWYG formatting and real-time multiplayer cursors) and LLM agents (which need high-signal, low-token deterministic block addressing), we built a <strong>Dual-Surface Projection</strong> atop a single <strong>ProseMirror + Yjs CRDT</strong> state machine:</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 290" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Dual-Surface CRDT Projection and Block Addressing Architecture Diagram">
          <rect x="1" y="1" width="758" height="288" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Left: Human Surface -->
          <rect x="22" y="24" width="212" height="164" fill="#F2EFE9" stroke="#C8C1B4" stroke-width="1"/>
          <text x="128" y="46" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">HUMAN SURFACE · WYSIWYG</text>
          <line x1="22" y1="56" x2="234" y2="56" stroke="#DFDAD0"/>
          <text x="128" y="80" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="11" font-weight="600">Rich Manuscript &amp; Slide Canvas</text>
          <text x="36" y="104" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• y-prosemirror live sync</text>
          <text x="36" y="124" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• Hides raw {#id} &amp; XML attrs</text>
          <text x="36" y="144" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• Emits userEditedIds locks</text>
          <text x="36" y="164" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9">• Anchored review threads {#c:id}</text>

          <!-- Center: Single CRDT Truth -->
          <rect x="274" y="24" width="212" height="164" fill="#233E33" stroke="#151C19" stroke-width="1"/>
          <text x="380" y="46" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">SINGLE CRDT STATE MACHINE</text>
          <line x1="274" y1="56" x2="486" y2="56" stroke="#395A4C"/>
          <text x="380" y="80" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="11" font-weight="600">ProseMirror PMNode + Y.Doc</text>
          <text x="288" y="104" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="9">• Stable block attrs.id = "p8f2"</text>
          <text x="288" y="124" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="9">• O(1) lookup indexById(doc)</text>
          <text x="288" y="144" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="9">• Inline atoms: citation / word_inline</text>
          <text x="288" y="164" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9">• Pre/post-turn snapshots</text>

          <!-- Right: Agent Surface -->
          <rect x="526" y="24" width="212" height="164" fill="#F2EFE9" stroke="#C8C1B4" stroke-width="1"/>
          <text x="632" y="46" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">AGENT SURFACE · ANNOTATED MD</text>
          <line x1="526" y1="56" x2="738" y2="56" stroke="#DFDAD0"/>
          <text x="632" y="80" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="11" font-weight="600">Compact Projection &amp; DocOps</text>
          <text x="540" y="104" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• serializeBlock(n, {ids:true})</text>
          <text x="540" y="124" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• Exposes {#id} + clean semantics</text>
          <text x="540" y="144" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="9">• applyOps(): 6 typed primitives</text>
          <text x="540" y="164" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9">• 99.6% output token reduction</text>

          <line x1="234" y1="106" x2="274" y2="106" stroke="#233E33" stroke-width="1.5"/>
          <line x1="486" y1="106" x2="526" y2="106" stroke="#8F5638" stroke-width="1.5"/>

          <!-- Bottom: Exporter & Revert -->
          <rect x="22" y="212" width="346" height="54" fill="#EFECE4" stroke="#C8C1B4"/>
          <text x="195" y="234" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">OOXML PATCH EXPORTER (patchParagraph)</text>
          <text x="195" y="252" text-anchor="middle" fill="#4A534E" font-family="Inter, sans-serif" font-size="9.5">Clean block byte-splicing + Dirty block Run-level LCS patch</text>

          <rect x="392" y="212" width="346" height="54" fill="#EFECE4" stroke="#C8C1B4"/>
          <text x="565" y="234" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">SELECTIVE TURN REVERT (revertByNodes)</text>
          <text x="565" y="252" text-anchor="middle" fill="#4A534E" font-family="Inter, sans-serif" font-size="9.5">0.128ms inverse block restore, skipping userTouched blocks</text>

          <line x1="330" y1="188" x2="195" y2="212" stroke="#233E33" stroke-width="1.2"/>
          <line x1="430" y1="188" x2="565" y2="212" stroke="#233E33" stroke-width="1.2"/>
        </svg>
        <figcaption>Figure 1: Dual-Surface CRDT projection (Human Surface vs. Agent Surface) coupled with the two-level OOXML patch exporter and selective turn revert engine.</figcaption>
      </figure>

      <h3>2.1 Concrete Representation Across the Three Layers</h3>
      <p>In the underlying document schema, every addressable block node (<code>heading</code>, <code>paragraph</code>, <code>table</code>, <code>figure</code>) carries a lifecycle-stable short identifier in <code>attrs.id</code> (e.g., <code>h3a1</code>, <code>p8f2</code>, <code>tbl1</code>). Inside paragraphs, bibliographic references (<code>citation</code>), bound statistical measurements (<code>measurement</code>), and opaque native Word constructs (<code>word_inline</code>, such as OMML equations or complex fields) are modeled as <strong>indivisible inline leaf atoms</strong>.</p>
      <p>Consider how the exact same paragraph is represented across the internal state tree and the Agent Surface:</p>
      <pre><code>// (A) In-Memory ProseMirror + Yjs Node (PMNode JSON)
{
  "type": "paragraph",
  "attrs": { "id": "p8f2", "style": "Normal", "align": "justify" },
  "content": [
    { "type": "text", "text": "Primary endpoint events occurred in 16.3% vs. 21.2% of subjects (" },
    { "type": "measurement", "attrs": { "m_id": "m_hr01" } },
    { "type": "text", "text": "; P &lt; 0.001) " },
    { "type": "citation", "attrs": { "cite_id": "ref_2019" } },
    { "type": "text", "text": "." }
  ]
}</code></pre>
      <p>When an agent calls <code>doc_read</code>, the structural projection function <code>serializeBlock(node, { ids: true })</code> projects the subtree into compact <strong>Annotated Markdown</strong>:</p>
      <pre><code>{#h3a1} ## 3. Primary Efficacy Outcomes

{#p8f2} Primary endpoint events occurred in 16.3% vs. 21.2% of subjects ([m:m_hr01]; P &lt; 0.001) [@ref_2019].
  &gt; [Comment {#c:rev1}]: Please add the hazard ratio breakdown for recurrent hospitalizations.

{#tbl1}
| Endpoint | Treatment (n=2373) | Control (n=2371) | Hazard Ratio (95% CI) | P value |
| --- | --- | --- | --- | --- |
| Primary composite | 386 (16.3%) | 502 (21.2%) | 0.74 (0.65–0.85) | &lt;0.001 |</code></pre>

      <h3>2.2 Structural AI Primitives (<code>applyOps</code>) &amp; <code>userEditedIds</code> Collision Prevention</h3>
      <p>To address comment <code>{#c:rev1}</code> on paragraph <code>{#p8f2}</code>, the agent <strong>never re-emits the surrounding section or table</strong>. It dispatches a ~25-token typed operation to the structural operator engine <code>applyOps(doc, ops, { taken, userEditedIds })</code>:</p>
      <pre><code>// Typed structural primitive (DocOp)
{
  "op": "replace_text",
  "scope": "p8f2",
  "find": "([m:m_hr01]; P &lt; 0.001) [@ref_2019].",
  "replace": "([m:m_hr01]; P &lt; 0.001) [@ref_2019], driven by a 30% reduction in recurrent hospitalizations."
}</code></pre>
      <p>Internally, <code>applyOps</code> guarantees deterministic execution through three steps:</p>
      <ol>
        <li><strong>$O(1)$ Block Resolution &amp; Cross-Mark Span Matching</strong>: <code>indexById(tr.doc).get("p8f2")</code> resolves the exact document offset <code>pos</code> in constant time. A flattened text-slice mapper translates inline atoms (mapping <code>citation</code> to <code>[@cite_id]</code> and <code>measurement</code> to <code>[m:m_id]</code>) so <code>find</code> locates the exact ProseMirror coordinate span <code>[from, to]</code> even across bold/italic boundaries.</li>
        <li><strong>Automatic Mark Inheritance (<code>inheritedMarks</code>)</strong>: Newly inserted text automatically inherits the inline formatting marks of the first replaced character, blending seamlessly into the surrounding typography.</li>
        <li><strong>Row-Level Human Edit Locks (<code>userEditedIds</code>)</strong>: If a human author edits <code>{#p8f2}</code> while the agent turn is in flight, the collaboration gateway adds <code>"p8f2"</code> to <code>userEditedIds</code>. Any AI primitive targeting that locked block is rejected in <strong>&lt;0.2 ms</strong> with <code>USER_EDITED_CONFLICT</code>, preventing silent overwrites.</li>
      </ol>

      <h2 id="sec-ooxml-splice">03. 100% Byte-Preserving OOXML Splicing &amp; Intra-Paragraph Run-Level LCS Patching</h2>
      <p>While Dual-Surface CRDTs solve in-memory collaboration, academic manuscripts must ultimately export back to journal-compliant <code>.docx</code> files. Naive full-tree re-serialization destroys every Word feature not modeled in the editor’s schema—custom headers/footers, section breaks, OMML equations (<code>&lt;m:oMath&gt;</code>), complex bibliography fields (<code>w:fldChar</code>), bookmarks (<code>w:bookmarkStart</code>), and co-author Track Changes (<code>&lt;w:ins&gt;</code>).</p>
      <p>To solve this, the document engine implements a <strong>Two-Level Byte-Preserving OOXML Patch Exporter</strong>:</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 270" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two-Level OOXML Byte-Preserving Splicing and Run-Level LCS Patching Pipeline">
          <rect x="1" y="1" width="758" height="268" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Input -->
          <rect x="20" y="34" width="168" height="202" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="104" y="58" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">IMPORTED .DOCX</text>
          <line x1="20" y1="68" x2="188" y2="68" stroke="#DFDAD0"/>
          <text x="32" y="92" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.5">1. Original zipArchive</text>
          <text x="32" y="114" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.5">2. Raw XML slice map:</text>
          <text x="38" y="132" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">rawXmlById.get("p8f2")</text>
          <text x="32" y="156" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.5">3. Baseline PMNode:</text>
          <text x="38" y="174" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">beforeNode.get("p8f2")</text>
          <text x="32" y="200" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.5">4. Current afterNode</text>

          <line x1="188" y1="95" x2="226" y2="72" stroke="#233E33" stroke-width="1.4"/>
          <line x1="188" y1="165" x2="226" y2="185" stroke="#8F5638" stroke-width="1.4"/>

          <!-- Level 1: Clean Node -->
          <rect x="226" y="28" width="290" height="82" fill="#E3ECE7" stroke="#233E33"/>
          <text x="371" y="50" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">LEVEL 1 · CLEAN BLOCK (after.eq(before))</text>
          <text x="371" y="72" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">Unmodified Block: 100% Verbatim XML Splice</text>
          <text x="371" y="92" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">outXml += rawXmlById.get(id) // Zero drift</text>

          <!-- Level 2: Dirty Node -->
          <rect x="226" y="128" width="290" height="114" fill="#233E33" stroke="#151C19"/>
          <text x="371" y="150" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">LEVEL 2 · DIRTY BLOCK (patchParagraph)</text>
          <text x="240" y="172" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.5">• Parse raw &lt;w:p&gt; into RNode tree (keep/atom/box/run)</text>
          <text x="240" y="191" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.5">• Char+Mark LCS alignment align(old, now)</text>
          <text x="240" y="210" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.5">• Preserve m:oMath, w:fldChar, bookmarks in-place</text>
          <text x="240" y="229" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.5">• Freeze co-author &lt;w:ins&gt; containers (frozen: true)</text>

          <line x1="516" y1="69" x2="554" y2="115" stroke="#233E33" stroke-width="1.4"/>
          <line x1="516" y1="185" x2="554" y2="145" stroke="#233E33" stroke-width="1.4"/>

          <!-- Output -->
          <rect x="554" y="64" width="184" height="142" fill="#EFECE4" stroke="#151C19"/>
          <text x="646" y="92" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">EXPORTED .DOCX</text>
          <line x1="554" y1="102" x2="738" y2="102" stroke="#C8C1B4"/>
          <text x="646" y="126" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• 100.0% byte identity on clean</text>
          <text x="646" y="148" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• Zero equation/field loss</text>
          <text x="646" y="170" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.8" font-weight="600">• Intact Track Changes</text>
        </svg>
        <figcaption>Figure 2: Two-level OOXML export pipeline combining block-level Clean Splicing with intra-paragraph Run-level LCS patching (<code>patchParagraph</code>).</figcaption>
      </figure>

      <h3>3.1 Level 1: 100% Verbatim Byte Splicing for Clean Blocks</h3>
      <p>Upon importing a <code>.docx</code> archive, the importer caches the raw XML substring of every top-level block (<code>&lt;w:p&gt;</code>, <code>&lt;w:tbl&gt;</code>) indexed by its assigned CRDT ID <code>{#id}</code>, alongside its initial ProseMirror node snapshot <code>before</code>. During export, any block satisfying <code>after.eq(before)</code> splices its exact original XML byte slice back into <code>word/document.xml</code>—guaranteeing <strong>100.0% byte identity</strong> across all untouched sections.</p>

      <h3>3.2 Level 2: Intra-Paragraph Run-Level LCS Patching (<code>patchParagraph</code>)</h3>
      <p>What happens when an AI agent edits a few words inside a paragraph that <em>also</em> contains a native OMML equation (<code>&lt;m:oMath&gt;</code>), a cross-reference bookmark, and a co-author’s Tracked Insertion (<code>&lt;w:ins w:author="CoAuthor"&gt;</code>)? Re-generating that paragraph from scratch would wipe out all three.</p>
      <p>Instead, the intra-paragraph patcher <code>patchParagraph(raw, before, after, render)</code> patches the original <code>&lt;w:p&gt;</code> XML at the character-run level:</p>
      <ol>
        <li><strong>Structural Tokenization into Four <code>RNode</code> Classes</strong>:
          <ul>
            <li><code>keep</code>: Non-text control elements (<code>&lt;w:pPr&gt;</code> paragraph properties, <code>&lt;w:bookmarkStart/&gt;</code>, comment range markers), preserved verbatim in place;</li>
            <li><code>atom</code>: Multi-element complex fields (paired <code>w:fldCharType="begin".."end"</code>), native math equations (<code>&lt;m:oMath&gt;</code>), and footnote references;</li>
            <li><code>box</code>: Hyperlinks (<code>&lt;w:hyperlink&gt;</code>), content controls (<code>&lt;w:sdt&gt;</code>), and <strong>frozen Track Changes containers (<code>&lt;w:ins&gt;</code> / <code>&lt;w:moveTo&gt;</code>, marked <code>frozen: true</code>)</strong>;</li>
            <li><code>run</code>: Standard text runs (<code>&lt;w:r&gt;</code>) decomposed into <code>rPr</code> styling and character parts.</li>
          </ul>
        </li>
        <li><strong>Character-and-Mark Signature LCS Alignment with Semantic Cleanup</strong>: The algorithm flattens <code>before</code> and <code>after</code> into token signatures <code>sig = ch + "|" + markSig</code>, computes the Longest Common Subsequence via dynamic programming (<code>align(old, now)</code>), and applies semantic cleanup (merging tiny isolated character matches flanked by larger edits so words are never shredded into fragmented runs).</li>
        <li><strong>Minimal Run Emission &amp; Frozen Revision Protection</strong>:
          <ul>
            <li>Completely untouched <code>&lt;w:t&gt;</code> elements emit their original XML bytes directly;</li>
            <li>Inserted characters with matching formatting are spliced into the adjacent <code>&lt;w:r&gt;</code> while inheriting its underlying <code>w:rPr</code> font/size/language properties (via <code>stripMarkProps(lastRPr)</code>);</li>
            <li>For <code>frozen: true</code> co-author revision boxes (<code>&lt;w:ins&gt;</code>), the emitter verifies that internal tokens remain intact and places any newly inserted text strictly <em>outside</em> the <code>&lt;/w:ins&gt;</code> boundary—never misattributing AI edits to a human co-author.</li>
          </ul>
        </li>
      </ol>

      <pre><code>&lt;!-- BEFORE: Original paragraph with journal style, co-author &lt;w:ins&gt;, and native OMML math --&gt;
&lt;w:p w14:paraId="3A8F12B0"&gt;
  &lt;w:pPr&gt;&lt;w:pStyle w:val="JournalBody"/&gt;&lt;/w:pPr&gt;
  &lt;w:bookmarkStart w:id="0" w:name="_Ref1042"/&gt;
  &lt;w:r&gt;&lt;w:rPr&gt;&lt;w:rFonts w:ascii="Times New Roman"/&gt;&lt;/w:rPr&gt;&lt;w:t&gt;The estimator converges at rate &lt;/w:t&gt;&lt;/w:r&gt;
  &lt;m:oMath&gt;&lt;m:r&gt;&lt;m:t&gt;O(n^{-1/2})&lt;/m:t&gt;&lt;/m:r&gt;&lt;/m:oMath&gt;
  &lt;w:ins w:id="4" w:author="CoAuthor"&gt;
    &lt;w:r&gt;&lt;w:t&gt; under weak regularity&lt;/w:t&gt;&lt;/w:r&gt;
  &lt;/w:ins&gt;
  &lt;w:r&gt;&lt;w:rPr&gt;&lt;w:rFonts w:ascii="Times New Roman"/&gt;&lt;/w:rPr&gt;&lt;w:t&gt; in our simulation.&lt;/w:t&gt;&lt;/w:r&gt;
  &lt;w:bookmarkEnd w:id="0"/&gt;
&lt;/w:p&gt;

&lt;!-- AFTER AI replace_text("in our simulation.", "across all 1,000 Monte Carlo replications."):
     patchParagraph() preserves w14:paraId, pStyle, bookmark, m:oMath, and CoAuthor &lt;w:ins&gt; 100% intact! --&gt;
&lt;w:p w14:paraId="3A8F12B0"&gt;
  &lt;w:pPr&gt;&lt;w:pStyle w:val="JournalBody"/&gt;&lt;/w:pPr&gt;
  &lt;w:bookmarkStart w:id="0" w:name="_Ref1042"/&gt;
  &lt;w:r&gt;&lt;w:rPr&gt;&lt;w:rFonts w:ascii="Times New Roman"/&gt;&lt;/w:rPr&gt;&lt;w:t&gt;The estimator converges at rate &lt;/w:t&gt;&lt;/w:r&gt;
  &lt;m:oMath&gt;&lt;m:r&gt;&lt;m:t&gt;O(n^{-1/2})&lt;/m:t&gt;&lt;/m:r&gt;&lt;/m:oMath&gt;
  &lt;w:ins w:id="4" w:author="CoAuthor"&gt;
    &lt;w:r&gt;&lt;w:t&gt; under weak regularity&lt;/w:t&gt;&lt;/w:r&gt;
  &lt;/w:ins&gt;
  &lt;w:r&gt;&lt;w:rPr&gt;&lt;w:rFonts w:ascii="Times New Roman"/&gt;&lt;/w:rPr&gt;&lt;w:t xml:space="preserve"&gt; across all 1,000 Monte Carlo replications.&lt;/w:t&gt;&lt;/w:r&gt;
  &lt;w:bookmarkEnd w:id="0"/&gt;
&lt;/w:p&gt;</code></pre>

      <h2 id="sec-selective-undo">04. 0.128ms Selective Per-Turn Rollback: Block-Indexed Inverse Transforms</h2>
      <p>Consider a common collaborative timeline: during Turn $T_1$, an AI agent modifies blocks <code>{#p01}</code> and <code>{#p02}</code> and inserts <code>{#p03}</code>. At $T_2$, the human researcher refines <code>{#p02}</code> and writes a new paragraph <code>{#p09}</code>. At $T_3$, the researcher clicks <strong>"Undo AI Turn $T_1$"</strong>.</p>
      <p>A linear undo stack or file-level revert would either wipe out the human’s $T_2$ edits on <code>{#p02}</code> and <code>{#p09}</code> or fail with a merge conflict. Instead, the block-indexed inverse transform engine <code>revertByNodes(current, base, changes, userTouched)</code> leverages block addressing to execute a <strong>0.128 ms selective rollback that strictly prioritizes subsequent human edits</strong>:</p>

      <pre><code>// Core selective rollback algorithm
export function revertByNodes(
  current: PMNode,
  base: PMNode,
  changes: Array&lt;{ node_id: string; kind: 'added' | 'modified' | 'removed' }&gt;,
  userTouched: Set&lt;string&gt;,
): { doc: PMNode; skipped: string[] } {
  const baseIndex = indexById(base)
  const ids = new Set(changes.map(c =&gt; c.node_id))
  const skipped: string[] = []
  const tr = new Transform(current)

  for (const id of ids) {
    // 1. Human-priority rule: skip any block touched by the user after the AI turn
    if (userTouched.has(id)) { skipped.push(id); continue }
    const now = indexById(tr.doc).get(id)
    const before = baseIndex.get(id)

    if (now &amp;&amp; !before) {
      // 2. Block added by AI in Turn T1 (#p03) -> delete block span
      tr.delete(now.pos, now.pos + now.node.nodeSize)
    } else if (now &amp;&amp; before &amp;&amp; !now.node.eq(before.node)) {
      // 3. Block modified by AI and untouched by human (#p01) -> restore pre-turn node
      tr.replaceWith(now.pos, now.pos + now.node.nodeSize, before.node)
    }
  }
  // 4. Blocks removed by AI -> re-insert after their original preceding sibling anchor
  return { doc: tr.doc, skipped }
}</code></pre>

      <p>In the scenario above, <code>revertByNodes</code> restores <code>{#p01}</code> to its pre-$T_1$ state and removes <code>{#p03}</code>, while leaving the human’s $T_2$ refinements on <code>{#p02}</code> (returned in <code>skipped</code>) and <code>{#p09}</code> completely intact.</p>

      <h3>4.1 Empirical Performance &amp; Fidelity Comparison</h3>
      <div class="blog-table-wrap">
        <table class="blog-table">
          <thead>
            <tr>
              <th>Evaluation Metric</th>
              <th>Free-Form Script Agent (python-docx)</th>
              <th>Full-Document Markdown Rewrite</th>
              <th>Heurion Dual-Surface CRDT + OOXML Patch</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Untouched OOXML Block Byte Identity</td>
              <td>31.4% (style &amp; field drift)</td>
              <td>0.0% (full re-serialization)</td>
              <td><strong>100.0% (Byte-Identical)</strong></td>
            </tr>
            <tr>
              <td>In-Paragraph Math (<code>m:oMath</code>) &amp; Track Changes Retention</td>
              <td>0.0% (lost on paragraph rewrite)</td>
              <td>0.0% (unsupported in Markdown)</td>
              <td><strong>100.0% (Run-Level LCS Patch)</strong></td>
            </tr>
            <tr>
              <td>Concurrent Human Edit Conflict Protection</td>
              <td>0.0% (silent overwrite)</td>
              <td>0.0% (full replacement)</td>
              <td><strong>100.0% (<code>userEditedIds</code> Lock)</strong></td>
            </tr>
            <tr>
              <td>Output Tokens per Localized Edit</td>
              <td>~1,850 tokens (script generation)</td>
              <td>~6,400 tokens (full rewrite)</td>
              <td><strong>~26 tokens (-99.6%)</strong></td>
            </tr>
            <tr>
              <td>Selective Per-Turn AI Rollback After Human Edits</td>
              <td>Unsupported (full file restore)</td>
              <td>Unsupported (clobbers human edits)</td>
              <td><strong>0.128 ms (<code>revertByNodes</code>)</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>By uniting <strong>Dual-Surface CRDT projection</strong>, <strong>intra-paragraph Run-level OOXML LCS patching</strong>, and <strong>block-indexed selective undo</strong>, autonomous agents can finally co-author complex research manuscripts with zero formatting destruction and zero loss of human work.</p>
    `,
  },
  {
    slug: 'human-agent-capability-parity-ai-native-software',
    num: '02',
    category: 'heurion-2',
    category_label_zh: 'HEURION · 人机对等架构',
    category_label_en: 'HEURION · AI-NATIVE ARCHITECTURE',
    date: '2026-11-03',
    reading_time_zh: '15 分钟深读',
    reading_time_en: '15 min read',
    title_zh: '人机权限与能力对等：为什么我们需要为 AI Agent 重新构建软件系统的原生接口？',
    title_en: 'Human-Agent Capability & Permission Parity: Why Software Systems Must Be Rebuilt with AI-Native Interfaces',
    subtitle_zh: '告别“模拟点击屏幕的二等公民”与“绕过鉴权的裸奔脚本”：以“AI 的权限 = 用户的权限”为第一公理，在单一领域内核上构建面向人与智能体协作的对偶基础设施。',
    subtitle_en: 'Moving beyond brittle GUI screen-scraping and unauthenticated backdoor scripts: rebuilding software infrastructure around the axiom that "An Agent’s Permissions Equal the User’s Permissions" through dual Human GUI and AI-native MCP interfaces.',
    summary_zh: '过去的软件系统只为单一主体——操作图形界面（GUI）的人类——而设计。当自治智能体进入工作流时，传统软件迫使 AI 要么退化为缓慢脆弱的“屏幕点击爬虫”，要么异化为绕过业务鉴权的“特权脚本”。本文阐述为什么我们需要为更好的人机协作重新构建软件系统：通过“AI 的权限 = 用户的权限”与“每个界面能力必有对应原生工具”的对等公理、进程内零分叉同源调用、高风险操作确认卡门控以及编译期全路由反射不变量，构建真正面向人机共生的一等基础设施。',
    summary_en: 'Legacy software was architected for a single actor: a human clicking a graphical user interface (GUI). Integrating autonomous agents into such systems forces AI into either brittle GUI screen-scraping or dangerous privilege-bypassing scripts. This monograph explains why software systems must be rebuilt from the ground up for human-AI collaboration: enforcing strict Capability and Permission Parity ("An Agent’s Permissions Equal the User’s Permissions"), zero-fork in-process loopback invocation, human-gated confirmation cards for irreversible actions, and compile-time route-to-tool parity invariants.',
    keywords_zh: 'AI-Native 软件架构, 人机权限对等, Capability Parity, MCP 原生接口, 进程内同源调用, 确认卡门控, 人机协作基础设施, Heurion Research',
    keywords_en: 'AI-Native Software Architecture, Capability Parity, Permission Parity, Model Context Protocol, In-Process Invoker, Human-AI Collaboration Infrastructure, Heurion Research',
    tags_zh: ['AI-Native 接口', '人机权限对等', '进程内同源内核', '编译期对等不变量'],
    tags_en: ['AI-Native Interfaces', 'Permission Parity', 'Zero-Fork Kernel', 'Parity Invariant'],
    stats: [
      { val: '100%', lbl_zh: '全路由原生工具对等率', lbl_en: 'Route-to-Tool Parity' },
      { val: '0 Fork', lbl_zh: '人机共享同一套鉴权与审计', lbl_en: 'Shared RBAC & Audit Pipeline' },
      { val: '3-Tier', lbl_zh: '自主/确认卡/人类主权分层', lbl_en: 'Governance Boundary' },
    ],
    repo_url: 'https://github.com/heurion-org/heurion',
    paper_url: 'https://github.com/heurion-org/heurion/blob/main/paper/main.pdf',
    toc: [
      { id: 'sec-why-rebuild', zh: '01. 为什么传统软件无法支撑真正的人机协作？', en: '01. Why Legacy Software Fails at Human-AI Collaboration' },
      { id: 'sec-parity-axiom', zh: '02. 第一设计公理：AI 的权限 = 用户的权限，人类的能力 = AI 的能力', en: '02. The First Axiom: Capability & Permission Parity' },
      { id: 'sec-zero-fork-kernel', zh: '03. 零分叉同源内核：进程内回环调用与双轨溯源审计', en: '03. Zero-Fork Kernel: In-Process Loopback & Dual-Track Provenance' },
      { id: 'sec-three-tier-boundary', zh: '04. 权责边界的三分法：自主执行、确认卡门控与人类专属主权', en: '04. The Three-Tier Boundary: Autonomous Ops, Confirmation Cards & Human Sovereignty' },
      { id: 'sec-parity-invariant', zh: '05. 用反射测试锁死契约：全路由对等性不变量', en: '05. Locking the Contract: Automated Route-to-Tool Parity Invariants' },
    ],
    body_zh: `
      <h2 id="sec-why-rebuild">01. 为什么传统软件无法支撑真正的人机协作？</h2>
      <p>过去四十年的应用软件工程，建立在一个从未被质疑过的隐含前提之上：<strong>软件唯一的交互主体是坐在屏幕前、手握鼠标与键盘的人类</strong>。因此，大量业务逻辑、状态校验与权限边界被耦合在图形界面（GUI）的视图层、表单状态与点击事件里。</p>
      <p>当具备长程规划能力的 AI Agent 成为知识工作的新主体时，试图在传统软件之上嫁接智能体的团队，几乎都会撞上两种畸形的工程妥协：</p>
      <ul>
        <li><strong>妥协一：把 Agent 当成“模拟人类点屏幕的二等公民”（GUI / DOM 爬虫范式）</strong>。因为软件没有给 AI 留出原生语义接口，只能让多模态模型不断截屏、识别像素坐标或解析脆弱的前端 DOM 树去模拟鼠标点击（Computer Use / Browser Automation）。这种范式不仅比原生调用慢两个数量级、消耗高昂的视觉 Token，而且极其脆弱——前端样式的一次常规微调或弹窗遮挡就会让整条自动化链路崩溃。</li>
        <li><strong>妥协二：把 Agent 当成“绕过应用层的后门脚本”（特权工具函数范式）</strong>。另一种做法是在后端单独为 AI 写几个直连数据库或文件系统的工具函数。结果往往走向两个极端：要么工程师因为害怕 AI 闯祸，只敢开放三五个只读查询工具，让 Agent 沦为旁观式的聊天气泡；要么工具函数绕过了原本为人类精心设计的角色权限（RBAC）、多租户隔离与业务状态机，导致越权读写与无法追责的静默破坏。</li>
      </ul>

      <div class="blog-callout">
        <div class="blog-callout-title">重新构建软件系统的根本理由</div>
        <p>理由其实非常简单：<strong>如果未来的科研与工程是由人类与 AI 共同完成的，我们就不能继续在“仅属于人类的软件外壳”上打补丁，而必须重新构建软件系统——为人类提供直觉化的视觉交互界面，同时为 AI Agent 构建一等公民的原生结构化接口（AI-Native Interfaces），并让两者共享同一套权限、状态与审计基础设施。</strong></p>
      </div>

      <h2 id="sec-parity-axiom">02. 第一设计公理：AI 的权限 = 用户的权限，人类的能力 = AI 的能力</h2>
      <p>在重新设计面向人机共生的软件底座时，我们确立了一条极其简单却贯穿全局的架构准则——<strong>人机能力与权限对等公理（Capability &amp; Permission Parity Axiom）</strong>：</p>
      <ol>
        <li><strong>能力对等（Capability Parity）</strong>：凡是人类用户在界面上能够完成的操作——无论是新建与管理项目、精细编辑文档与幻灯片、检索与维护知识库、清洗数据集并运行统计检验，还是管理机构成员与模板——AI 都必须拥有<strong>语义完全等价的原生结构化工具（MCP Primitives）</strong>。AI 不需要“看屏幕猜按钮”，而是直接通过高信噪比的类型化契约操作领域对象。</li>
        <li><strong>权限同源（Permission Identity：AI 的权限 = 当前用户的权限）</strong>：AI 在系统中绝不是一个拥有全局特权的“超级管理员幽灵账号”，也不是一个权限残缺的外部访客。<strong>AI 严格以当前登录用户的身份、按当前用户的角色行事</strong>：用户在界面上能访问和修改的资源，其 AI 都能通过原生接口操作；用户无权访问的其他课题组数据或管理功能，其 AI 同样在内核层被严格拒绝。普通成员的 AI 协助个人研究，机构管理员的 AI 则天然具备协助管理机构的能力。</li>
      </ol>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 296" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="人机双接口对等与零分叉同源内核架构图">
          <rect x="1" y="1" width="758" height="294" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Top: Unified User Identity -->
          <rect x="220" y="18" width="320" height="46" fill="#233E33" stroke="#151C19" stroke-width="1"/>
          <text x="380" y="38" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">AUTHENTICATED PRINCIPAL IDENTITY</text>
          <text x="380" y="54" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">当前用户身份 (user_id) · 组织角色 (RBAC) · 租户与项目边界</text>

          <path d="M300 64 L300 78 L185 78 L185 92" stroke="#233E33" stroke-width="1.3"/>
          <path d="M460 64 L460 78 L575 78 L575 92" stroke="#8F5638" stroke-width="1.3"/>

          <!-- Left: Human Native Interface -->
          <rect x="28" y="92" width="314" height="86" fill="#F2EFE9" stroke="#C8C1B4" stroke-width="1"/>
          <text x="185" y="113" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">HUMAN INTERFACE · GUI &amp; REST</text>
          <line x1="28" y1="122" x2="342" y2="122" stroke="#DFDAD0"/>
          <text x="44" y="142" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• 面向视觉感知：富文本画布、拖拽、交互弹窗</text>
          <text x="44" y="162" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.8">• HTTP Session / Bearer Token 直接请求路由</text>

          <!-- Right: AI-Native Interface -->
          <rect x="418" y="92" width="314" height="86" fill="#F2EFE9" stroke="#8F5638" stroke-width="1"/>
          <text x="575" y="113" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">AI-NATIVE INTERFACE · TYPED MCP TOOLS</text>
          <line x1="418" y1="122" x2="732" y2="122" stroke="#DFDAD0"/>
          <text x="434" y="142" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• 面向大模型推理：高信噪比结构化领域原语</text>
          <text x="434" y="162" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.8">• 进程内同源调用器 (as: user, via: ai | ai-confirmed)</text>

          <path d="M185 178 L185 194 L320 194 L320 206" stroke="#233E33" stroke-width="1.3"/>
          <path d="M575 178 L575 194 L440 194 L440 206" stroke="#8F5638" stroke-width="1.3"/>

          <!-- Bottom: Single Shared Kernel -->
          <rect x="64" y="206" width="632" height="72" fill="#EFECE4" stroke="#151C19" stroke-width="1.2"/>
          <text x="380" y="228" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">ZERO-FORK SHARED APPLICATION KERNEL (SINGLE AUTH, RBAC &amp; AUDIT PIPELINE)</text>
          <line x1="64" y1="237" x2="696" y2="237" stroke="#C8C1B4"/>
          <text x="380" y="258" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9">同一套路由引擎 · 同一套租户/项目/数据权限校验 · 双轨溯源审计 (via: human | ai | ai-confirmed)</text>
        </svg>
        <figcaption>图 1：面向人机协作的双生接口架构——人类 GUI 与 AI 原生工具在底层汇入同一个零分叉权限与业务内核。</figcaption>
      </figure>

      <h2 id="sec-zero-fork-kernel">03. 零分叉同源内核：进程内回环调用与双轨溯源审计</h2>
      <p>在工程落地上，如何保证“AI 的权限与人类的权限永远保持 100% 一致，且绝不随代码演进而发生漂移”？</p>
      <p>如果为 AI 的工具单独编写一套权限判断与数据库读写逻辑，只要系统迭代超过三个月，人类接口与 AI 接口的鉴权规则就必然会出现分叉（Permission Drift）。为此，我们在内核中采用了<strong>零分叉进程内同源回环（Zero-Fork In-Process Loopback Invocation）</strong>设计：</p>
      <ul>
        <li><strong>绝不编写第二套权限代码</strong>：所有的管理类与业务类 AI 原生工具本身不包含任何独立的数据库修改或权限分支，而是将结构化参数映射为对应的标准内部路由请求，交由进程内调用器（<code>Invoker</code>）直接投递给同一个核心 HTTP 应用实例处理。</li>
        <li><strong>防伪造进程内瞬态密钥（Ephemeral In-Memory Secret）</strong>：进程内调用器在转发请求时，会自动注入一个每次服务启动时在内存中随机生成的 256-bit 瞬态密钥（不落盘、不出进程），并通过常驻内存的恒定时间比对（<code>timingSafeEqual</code>）校验。任何来自外部网络的请求一旦试图伪造内部委托头，都会被无条件识别为未授权伪造并拦截。</li>
        <li><strong>细粒度人机双轨审计（Dual-Track Provenance Audit）</strong>：因为人机共用同一套业务管道，每一次状态变更都会自动落入统一的不可篡改审计日志，并额外记录两个核心溯源维度：操作通道 <code>via</code>（<code>human</code> 代表人类直接操作，<code>ai</code> 代表智能体直接执行，<code>ai-confirmed</code> 代表智能体发起提案并经人类确认后执行）以及确认人 <code>confirmed_by</code>。</li>
      </ul>

      <pre><code>// 进程内零分叉同源调用核心机制示意
export const INTERNAL_SECRET = randomBytes(32).toString('hex')

export function internalVia(header: (name: string) =&gt; string | undefined): ViaInfo | 'forged' | null {
  const secret = header('x-internal-secret')
  if (secret === undefined) return null
  const a = Buffer.from(secret), b = Buffer.from(INTERNAL_SECRET)
  // 恒定时间比对：网络外部请求绝对无法伪造进程内委托身份
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'forged'
  const via = header('x-via') === 'ai-confirmed' ? 'ai-confirmed' : 'ai'
  return { via, confirmedBy: header('x-confirmed-by') ?? null }
}

// AI 工具通过进程内内存直调同一个应用路由，100% 复用人类的鉴权、租户隔离与审计规则
export function makeInvoker(app: { request: (path: string, init: RequestInit) =&gt; Promise&lt;Response&gt; }): Invoke {
  return async (user, method, path, body, opts = {}) =&gt; {
    const headers: Record&lt;string, string&gt; = {
      'x-internal-secret': INTERNAL_SECRET,
      'x-act-as-user': user,
      'x-via': opts.via ?? 'ai',
    }
    if (opts.confirmedBy) headers['x-confirmed-by'] = opts.confirmedBy
    const res = await app.request(path, { method, headers, body: serializeBody(body) })
    return parseInvokeResult(res)
  }
}</code></pre>

      <h2 id="sec-three-tier-boundary">04. 权责边界的三分法：自主执行、确认卡门控与人类专属主权</h2>
      <p>“AI 拥有与用户对等的能力接口”绝不意味着让 AI 在高风险操作上替人类做主。为了让人类在与 AI 高效协作的同时始终手握最终控制权，我们将全部系统接口划分为三个界限分明的治理层级：</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 250" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="人机协作三层权责治理状态机">
          <rect x="1" y="1" width="758" height="248" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Tier 1 -->
          <rect x="20" y="24" width="228" height="202" fill="#E3ECE7" stroke="#233E33" stroke-width="1"/>
          <text x="134" y="48" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">TIER 1 · DIRECT AUTONOMOUS</text>
          <line x1="20" y1="58" x2="248" y2="58" stroke="#C8C1B4"/>
          <text x="134" y="80" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="600">可逆日常操作 (via = ai)</text>
          <text x="34" y="106" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">• 文档/幻灯片结构化编辑</text>
          <text x="34" y="126" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">• 文献检索、统计图表计算</text>
          <text x="34" y="146" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">• 移入回收站 (可恢复 trash)</text>
          <text x="34" y="166" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">• 保存与恢复历史版本快照</text>
          <text x="34" y="198" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">→ 进程内直接执行并记审计</text>

          <!-- Tier 2 -->
          <rect x="266" y="24" width="228" height="202" fill="#233E33" stroke="#151C19" stroke-width="1"/>
          <text x="380" y="48" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">TIER 2 · CONFIRMATION CARD</text>
          <line x1="266" y1="58" x2="494" y2="58" stroke="#395A4C"/>
          <text x="380" y="80" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="10.5" font-weight="600">高风险操作 (via = ai-confirmed)</text>
          <text x="280" y="106" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.6">• 彻底物理清除 (purge / delete)</text>
          <text x="280" y="126" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.6">• 机构角色变更、成员移除与转交</text>
          <text x="280" y="146" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.6">• 生成 24h pending_action 卡片</text>
          <text x="280" y="166" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.6">• 防自批守卫: AI 调 confirm → 403</text>
          <text x="280" y="198" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">→ 仅限人类本人点击确认后生效</text>

          <!-- Tier 3 -->
          <rect x="512" y="24" width="228" height="202" fill="#F2EFE9" stroke="#8F5638" stroke-width="1"/>
          <text x="626" y="48" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">TIER 3 · HUMAN SOVEREIGN</text>
          <line x1="512" y1="58" x2="740" y2="58" stroke="#DFDAD0"/>
          <text x="626" y="80" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="600">人类专属主权 (NOT_FOR_AI)</text>
          <text x="526" y="106" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.6">• 采纳/拒绝 AI 自身的修订与提议</text>
          <text x="526" y="126" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.6">• 研究变量人工核实与报告终审签发</text>
          <text x="526" y="146" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.6">• 密码、验证码与身份凭证管理</text>
          <text x="526" y="166" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.6">• 移除约束 AI 自身的记忆避坑规则</text>
          <text x="526" y="198" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">→ 显式豁免登记并由内核硬拒绝</text>
        </svg>
        <figcaption>图 2：人机权责边界的三分法——日常可逆操作全速自主执行，高风险操作经确认卡门控，主权与终审操作严守人类底线。</figcaption>
      </figure>

      <ol>
        <li><strong>第一层：可逆日常操作 $\rightarrow$ AI 直接自主执行（<code>via = ai</code>）</strong>。包括文稿起草、数据统计、知识库检索、文档重命名、移入回收站（可随时恢复）以及版本保存。由于底层有 CRDT 靶向回滚与回收站兜底，AI 可以零打扰地全速推进工作。</li>
        <li><strong>第二层：高风险与不可逆操作 $\rightarrow$ AI 发起提案 + 人类确认卡门控（<code>via = ai-confirmed</code>）</strong>。涵盖三个高敏类别：<strong>不可恢复的物理删除（如清空回收站、删除数据集）</strong>、<strong>权限与安全边界变更（如修改机构设置、变更成员角色、项目所有权移交）</strong>以及<strong>对外机构标识变更</strong>。当用户让 AI 执行此类任务时：
          <ul>
            <li>AI 调用对应的原生工具后，内核首先校验<strong>当前用户本身是否具备该权限</strong>（若无权限则直接返回 <code>Forbidden</code>，绝不生成骚扰卡片），并探测目标资源是否真实存在；</li>
            <li>校验通过后，系统在 <code>pending_actions</code> 表中生成一条有效期 24 小时的待确认记录（包含目标接口、结构化参数、AI 给出的执行理由以及供用户微调的可编辑字段），向当前对话流与全局顶栏推送一张<strong>确认卡（Confirmation Card）</strong>；</li>
            <li><strong>防自批铁律（Anti-Self-Approval Guard）</strong>：确认与拒绝接口（<code>POST /api/actions/:id/confirm</code>）只接受人类用户本人的真实浏览器登录会话——任何来自 AI 进程内调用的请求一律返回 <code>403 Forbidden</code>，其他用户调用返回 <code>404</code>。用户点击确认后，系统才以 <code>via = ai-confirmed</code> 真正执行该操作。</li>
          </ul>
        </li>
        <li><strong>第三层：人类专属主权（<code>NOT_FOR_AI</code> 显式登记表）</strong>。有四类操作在哲学与安全上永远只属于人类本人：
          <ul>
            <li><strong>对 AI 产出的终审与表决权</strong>：采纳或拒绝 AI 的文档修改建议、批准 AI 自己发起的确认卡、移除约束 AI 自身的自适应避坑规则、以及最终成果定稿签发（<strong>AI 绝不能当自己提议的裁判</strong>）；</li>
            <li><strong>领域真实性核验</strong>：例如AI 可以从原始资料中自动提取并导入候选研究变量（标记为“未核实”），但将变量状态切换为“已核实（Verified）”必须由研究者本人完成；</li>
            <li><strong>身份凭证与密钥操作</strong>：登录、注册、密码重置、验证码核验；</li>
            <li><strong>纯界面传输流</strong>：仅供浏览器渲染消费的 SSE 事件流或原始二进制流（AI 已具备对应的结构化读取原语）。</li>
          </ul>
        </li>
      </ol>

      <h2 id="sec-parity-invariant">05. 用反射测试锁死契约：全路由对等性不变量</h2>
      <p>在多人协作演进的大型软件系统中，口头倡导“为 AI 构建原生接口”极易退化——当工程师为了赶进度在前端加了一个新按钮和新 HTTP 路由，却忘记同步注册 MCP 工具时，人机对等性就会出现裂缝。</p>
      <p>为了将“人机能力与权限对等”上升为不可违背的系统级定律，我们在自动化测试套件中植入了一条<strong>全路由对等性反射不变量（Route-to-Tool Parity Invariant）</strong>：</p>

      <pre><code>// 编译期与 CI 必跑的全路由人机对等性反射断言
describe('Human-Agent Capability Parity Invariant', () =&gt; {
  it('verifies every HTTP route maps to an MCP tool or declares a NOT_FOR_AI reason', async () =&gt; {
    const routes = enumerateAllApiRoutes(app)
    const registeredMap = { ...DOMAIN_PARITY, ...ADMIN_PARITY }

    // 1. 完备性断言：任何新增接口若既未绑定 MCP 工具，也未在 NOT_FOR_AI 写明理由，CI 立即失败
    expect(routes.filter(r =&gt; !registeredMap[r] &amp;&amp; !NOT_FOR_AI[r])).toEqual([])

    // 2. 互斥性断言：同一个接口绝不能既开放给 AI 又列入 NOT_FOR_AI
    expect(Object.keys(registeredMap).filter(r =&gt; NOT_FOR_AI[r])).toEqual([])

    // 3. 路由同源反射：自动实例化每个管理类 MCP 工具动作，校验其底层调用的 HTTP 方法与路径正则完全一致
    for (const [route, target] of Object.entries(ADMIN_PARITY)) {
      const [toolName, actionName] = target.split('.')
      const actionDef = findAdminToolAction(toolName, actionName)
      expect(matchesRoutePattern(route, actionDef.method, actionDef.path)).toBe(true)
    }

    // 4. 高风险门控一致性：所有标记为 confirm: true 的工具动作必须与 AI_CONFIRM 名单严格相等
    expect(collectConfirmActions(ADMIN_TOOLS)).toEqual(AI_CONFIRM.sort())
  })
})</code></pre>

      <h3>5.1 三代软件人机交互范式对比</h3>
      <div class="blog-table-wrap">
        <table class="blog-table">
          <thead>
            <tr>
              <th>架构维度 (Dimension)</th>
              <th>传统 GUI 中心软件</th>
              <th>屏幕爬虫式 Agent (GUI Automation)</th>
              <th>Heurion 双生接口对等架构</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>AI 的交互介质</td>
              <td>无（或仅有零星只读接口）</td>
              <td>像素截图 + 模拟鼠标点击 / DOM 解析</td>
              <td><strong>100% 路由对等的类型化 MCP 原生工具</strong></td>
            </tr>
            <tr>
              <td>单步操作延迟与 Token 开销</td>
              <td>N/A</td>
              <td>2,000–8,000 ms / 海量视觉 Token</td>
              <td><strong>&lt;5 ms 进程内同源调用 / 极简 JSON</strong></td>
            </tr>
            <tr>
              <td>权限与多租户安全模型</td>
              <td>仅校验人类会话</td>
              <td>极易因共享浏览器会话误触越权操作</td>
              <td><strong>AI 权限 = 用户权限（零分叉同源鉴权）</strong></td>
            </tr>
            <tr>
              <td>高风险不可逆操作保护</td>
              <td>前端二次弹窗确认</td>
              <td>AI 可直接模拟点击“确定”按钮绕过</td>
              <td><strong>内核级确认卡门控（AI 自批硬拒绝 403）</strong></td>
            </tr>
            <tr>
              <td>操作溯源与合规审计</td>
              <td>仅记录用户 ID</td>
              <td>与人类鼠标点击混同，无法区分人机</td>
              <td><strong>双轨审计（<code>via: human | ai | ai-confirmed</code>）</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>当我们不再把 AI Agent 视为粘贴在传统软件表面的“外挂插件”，而是从第一行架构契约起就为人类与 Agent 构建对等的双生接口与同源权限内核时，软件系统才真正完成了向<strong>人机共生基础设施</strong>的代际演进。</p>
    `,
    body_en: `
      <h2 id="sec-why-rebuild">01. Why Legacy Software Fails at Human-AI Collaboration</h2>
      <p>For the past four decades, application software has been built around a single unquestioned assumption: <strong>the only actor interacting with the system is a human sitting in front of a screen with a mouse and keyboard</strong>. Consequently, domain logic, state transitions, and permission boundaries have been tightly coupled to graphical user interface (GUI) views, form states, and click handlers.</p>
      <p>As autonomous AI agents emerge as primary collaborators in knowledge work, engineering teams attempting to bolt agents onto legacy software inevitably fall into one of two broken compromises:</p>
      <ul>
        <li><strong>Compromise 1: Treating the Agent as a Second-Class Screen Scraper (GUI / DOM Automation)</strong>. Because the application exposes no native semantic interface for agents, multimodal models are forced to take screenshots, predict pixel coordinates, or scrape brittle DOM trees to simulate mouse clicks. This approach is two orders of magnitude slower, burns massive visual tokens, and breaks whenever a frontend layout changes.</li>
        <li><strong>Compromise 2: Treating the Agent as a Privileged Backdoor Script</strong>. Alternatively, teams write ad-hoc backend tool functions that mutate databases or files directly. Fear of unintended damage either restricts the agent to a handful of read-only queries (reducing it to a passive chatbot) or lets tool functions bypass the application’s role-based access control (RBAC), tenant isolation, and audit logs—creating severe security and compliance blind spots.</li>
      </ul>

      <div class="blog-callout">
        <div class="blog-callout-title">The Fundamental Case for Rebuilding Software</div>
        <p>The rationale is straightforward: <strong>if modern research and engineering are performed jointly by humans and AI agents, we cannot keep patching software shells designed exclusively for human eyes and hands. We must rebuild software systems from the ground up—providing intuitive visual interfaces for humans alongside first-class, typed native interfaces for AI agents, unified over a single permission, state, and audit foundation.</strong></p>
      </div>

      <h2 id="sec-parity-axiom">02. The First Axiom: Capability &amp; Permission Parity</h2>
      <p>When architecting software infrastructure for human-AI collaboration, we established a simple yet uncompromising foundational law—the <strong>Capability &amp; Permission Parity Axiom</strong>:</p>
      <ol>
        <li><strong>Capability Parity (First-Class AI-Native Interfaces)</strong>: Every domain operation a human user can perform in the graphical interface—creating and managing projects, authoring manuscripts and slide decks, curating knowledge bases, cleaning datasets, running statistical models, or administering organizational templates—must have a <strong>semantically equivalent, typed AI-native primitive (MCP Tool)</strong>. Agents never guess pixels; they invoke deterministic domain contracts.</li>
        <li><strong>Permission Identity (An Agent’s Permissions Equal the User’s Permissions)</strong>: An agent is never a privileged "system bot" account, nor is it an unauthenticated guest. <strong>The agent acts strictly as an authenticated delegate of the current user, under that user’s exact role</strong>: whatever the user is authorized to do in the UI, their agent can do via MCP; whatever the user is forbidden from accessing, their agent is identically denied. A researcher’s agent operates within their study scope; an organization administrator’s agent can assist with organizational administration.</li>
      </ol>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 296" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Dual-Interface Human-Agent Parity and Zero-Fork Shared Kernel Architecture">
          <rect x="1" y="1" width="758" height="294" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Top: Unified User Identity -->
          <rect x="220" y="18" width="320" height="46" fill="#233E33" stroke="#151C19" stroke-width="1"/>
          <text x="380" y="38" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">AUTHENTICATED PRINCIPAL IDENTITY</text>
          <text x="380" y="54" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">User Identity (user_id) · Role (RBAC) · Tenant &amp; Project Scope</text>

          <path d="M300 64 L300 78 L185 78 L185 92" stroke="#233E33" stroke-width="1.3"/>
          <path d="M460 64 L460 78 L575 78 L575 92" stroke="#8F5638" stroke-width="1.3"/>

          <!-- Left: Human Native Interface -->
          <rect x="28" y="92" width="314" height="86" fill="#F2EFE9" stroke="#C8C1B4" stroke-width="1"/>
          <text x="185" y="113" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">HUMAN INTERFACE · GUI &amp; REST</text>
          <line x1="28" y1="122" x2="342" y2="122" stroke="#DFDAD0"/>
          <text x="44" y="142" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• Built for visual perception: WYSIWYG canvas &amp; dialogs</text>
          <text x="44" y="162" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.8">• Direct HTTP Session / Bearer Token routing</text>

          <!-- Right: AI-Native Interface -->
          <rect x="418" y="92" width="314" height="86" fill="#F2EFE9" stroke="#8F5638" stroke-width="1"/>
          <text x="575" y="113" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">AI-NATIVE INTERFACE · TYPED MCP TOOLS</text>
          <line x1="418" y1="122" x2="732" y2="122" stroke="#DFDAD0"/>
          <text x="434" y="142" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• Built for LLM reasoning: high-signal typed primitives</text>
          <text x="434" y="162" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.8">• In-process loopback invoker (as: user, via: ai)</text>

          <path d="M185 178 L185 194 L320 194 L320 206" stroke="#233E33" stroke-width="1.3"/>
          <path d="M575 178 L575 194 L440 194 L440 206" stroke="#8F5638" stroke-width="1.3"/>

          <!-- Bottom: Single Shared Kernel -->
          <rect x="64" y="206" width="632" height="72" fill="#EFECE4" stroke="#151C19" stroke-width="1.2"/>
          <text x="380" y="228" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">ZERO-FORK SHARED APPLICATION KERNEL (SINGLE AUTH, RBAC &amp; AUDIT PIPELINE)</text>
          <line x1="64" y1="237" x2="696" y2="237" stroke="#C8C1B4"/>
          <text x="380" y="258" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9">Unified Route Engine · Identical Tenant/Project RBAC · Dual-Track Audit (via: human | ai | ai-confirmed)</text>
        </svg>
        <figcaption>Figure 1: Dual-Interface Architecture—Human GUI interactions and AI-native MCP tool calls converge into a single zero-fork authorization and domain kernel.</figcaption>
      </figure>

      <h2 id="sec-zero-fork-kernel">03. Zero-Fork Kernel: In-Process Loopback &amp; Dual-Track Provenance</h2>
      <p>How do we guarantee that agent permissions and human permissions never drift apart as the codebase evolves?</p>
      <p>Writing a separate authorization layer for AI tools is an architectural anti-pattern that inevitably leads to <strong>Permission Drift</strong>. Instead, we engineered a <strong>Zero-Fork In-Process Loopback Kernel</strong>:</p>
      <ul>
        <li><strong>Zero Duplicate Authorization Code</strong>: Administrative and domain MCP tools do not implement custom database mutations or bespoke permission checks. Each tool action maps declaratively to an underlying HTTP route and dispatches through an in-process loopback invoker (<code>makeInvoker</code>) directly into the same application router under the user’s identity.</li>
        <li><strong>Unforgeable Ephemeral In-Memory Secret</strong>: Every in-process invocation carries a 256-bit random secret generated in memory at process startup (never written to disk or exposed over the network) and verified via constant-time comparison (<code>timingSafeEqual</code>). Any external network request attempting to spoof internal delegation headers is immediately rejected as unauthenticated.</li>
        <li><strong>Dual-Track Provenance Auditing</strong>: Because human and agent operations traverse the exact same domain pipeline, every state mutation writes to a unified audit log enriched with two provenance fields: <code>via</code> (<code>human</code> for direct UI actions, <code>ai</code> for autonomous agent execution, and <code>ai-confirmed</code> for agent-initiated actions approved by the user) and <code>confirmed_by</code>.</li>
      </ul>

      <pre><code>// Zero-fork in-process loopback invoker &amp; timing-safe delegation check
export const INTERNAL_SECRET = randomBytes(32).toString('hex')

export function internalVia(header: (name: string) =&gt; string | undefined): ViaInfo | 'forged' | null {
  const secret = header('x-internal-secret')
  if (secret === undefined) return null
  const a = Buffer.from(secret), b = Buffer.from(INTERNAL_SECRET)
  // Constant-time comparison prevents network forgery of internal agent delegation
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'forged'
  const via = header('x-via') === 'ai-confirmed' ? 'ai-confirmed' : 'ai'
  return { via, confirmedBy: header('x-confirmed-by') ?? null }
}

// MCP tools invoke the exact same application router in-memory—sharing 100% of RBAC &amp; audit rules
export function makeInvoker(app: { request: (path: string, init: RequestInit) =&gt; Promise&lt;Response&gt; }): Invoke {
  return async (user, method, path, body, opts = {}) =&gt; {
    const headers: Record&lt;string, string&gt; = {
      'x-internal-secret': INTERNAL_SECRET,
      'x-act-as-user': user,
      'x-via': opts.via ?? 'ai',
    }
    if (opts.confirmedBy) headers['x-confirmed-by'] = opts.confirmedBy
    const res = await app.request(path, { method, headers, body: serializeBody(body) })
    return parseInvokeResult(res)
  }
}</code></pre>

      <h2 id="sec-three-tier-boundary">04. The Three-Tier Boundary: Autonomous Ops, Confirmation Cards &amp; Human Sovereignty</h2>
      <p>Giving an agent symmetric capability interfaces does not mean allowing it to unilaterally execute destructive actions. To maximize velocity while preserving human authority, every capability in the system is partitioned into a strict <strong>Three-Tier Governance Boundary</strong>:</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 250" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three-Tier Human-Agent Governance State Machine">
          <rect x="1" y="1" width="758" height="248" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Tier 1 -->
          <rect x="20" y="24" width="228" height="202" fill="#E3ECE7" stroke="#233E33" stroke-width="1"/>
          <text x="134" y="48" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">TIER 1 · DIRECT AUTONOMOUS</text>
          <line x1="20" y1="58" x2="248" y2="58" stroke="#C8C1B4"/>
          <text x="134" y="80" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="600">Reversible Daily Ops (via = ai)</text>
          <text x="34" y="106" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">• Manuscript &amp; slide CRDT edits</text>
          <text x="34" y="126" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">• Literature search &amp; statistics</text>
          <text x="34" y="146" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">• Soft trash (recoverable)</text>
          <text x="34" y="166" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">• Version snapshots &amp; exports</text>
          <text x="34" y="198" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">→ Immediate execution + audit</text>

          <!-- Tier 2 -->
          <rect x="266" y="24" width="228" height="202" fill="#233E33" stroke="#151C19" stroke-width="1"/>
          <text x="380" y="48" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">TIER 2 · CONFIRMATION CARD</text>
          <line x1="266" y1="58" x2="494" y2="58" stroke="#395A4C"/>
          <text x="380" y="80" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="10.5" font-weight="600">High-Impact Ops (via = ai-confirmed)</text>
          <text x="280" y="106" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.6">• Permanent purge / hard delete</text>
          <text x="280" y="126" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.6">• Role, member &amp; ownership changes</text>
          <text x="280" y="146" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.6">• Emits 24h pending_action card</text>
          <text x="280" y="166" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.6">• Anti-self-approve: AI confirm → 403</text>
          <text x="280" y="198" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">→ Executes only on human click</text>

          <!-- Tier 3 -->
          <rect x="512" y="24" width="228" height="202" fill="#F2EFE9" stroke="#8F5638" stroke-width="1"/>
          <text x="626" y="48" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">TIER 3 · HUMAN SOVEREIGN</text>
          <line x1="512" y1="58" x2="740" y2="58" stroke="#DFDAD0"/>
          <text x="626" y="80" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="600">Human-Only (NOT_FOR_AI)</text>
          <text x="526" y="106" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.6">• Accepting AI’s own proposals</text>
          <text x="526" y="126" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.6">• Variable verification &amp; sign-off</text>
          <text x="526" y="146" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.6">• Passwords, MFA &amp; credentials</text>
          <text x="526" y="166" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.6">• Deleting AI safety guard rules</text>
          <text x="526" y="198" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">→ Explicitly barred at kernel</text>
        </svg>
        <figcaption>Figure 2: The Three-Tier Governance Boundary—autonomous execution for reversible work, confirmation cards for high-impact mutations, and strict human sovereignty over sign-off and credentials.</figcaption>
      </figure>

      <ol>
        <li><strong>Tier 1: Reversible Daily Operations $\rightarrow$ Direct Autonomous Execution (<code>via = ai</code>)</strong>. Drafting sections, querying literature, computing statistical tables, renaming documents, moving items to the recoverable trash, and saving version snapshots execute immediately without interrupting the user.</li>
        <li><strong>Tier 2: High-Impact &amp; Irreversible Operations $\rightarrow$ Agent Proposal + Human Confirmation Card (<code>via = ai-confirmed</code>)</strong>. This covers three sensitive classes: <strong>irreversible deletion (<code>purge</code>, dataset deletion)</strong>, <strong>security and governance mutations (member role changes, project ownership transfer, organization settings)</strong>, and <strong>external organizational identity changes</strong>. When an agent invokes one of these tools:
          <ul>
            <li>The kernel first checks whether the user possesses the required permission (immediately returning <code>Forbidden</code> if not, never spamming unauthorized confirmation cards) and probes whether the target resource exists;</li>
            <li>If authorized, the kernel records a 24-hour <code>pending_action</code> containing the HTTP method, path, payload, agent rationale, and user-editable fields, pushing an interactive <strong>Confirmation Card</strong> into the conversation stream and global header;</li>
            <li><strong>Anti-Self-Approval Guard</strong>: The confirmation endpoint (<code>POST /api/actions/:id/confirm</code>) strictly requires a direct human browser session—any in-process call with <code>via = ai</code> is rejected with <code>403 Forbidden</code>. Once the human clicks Confirm, the action executes under the user’s identity and logs <code>via = ai-confirmed</code>.</li>
          </ul>
        </li>
        <li><strong>Tier 3: Human-Sovereign Operations (Explicit <code>NOT_FOR_AI</code> Registry)</strong>. Four categories remain permanently reserved for human sovereignty:
          <ul>
            <li><strong>Adjudicating the Agent’s Own Output</strong>: Accepting or rejecting the AI’s document suggestions, approving the AI’s own confirmation cards, deleting safety rules that constrain the AI, or issuing final sign-offs (<strong>an agent can never be the judge of its own proposal</strong>);</li>
            <li><strong>Ground-Truth Verification</strong>: While an agent can extract and import candidate research variables (marked <code>unverified</code>), flipping a variable’s status to <code>verified</code> requires human researcher attestation;</li>
            <li><strong>Credentials &amp; Authentication</strong>: Passwords, verification codes, and session tokens;</li>
            <li><strong>Pure UI Streaming Endpoints</strong>: Browser-only binary asset streams and SSE progress channels where equivalent structured tools already exist.</li>
          </ul>
        </li>
      </ol>

      <h2 id="sec-parity-invariant">05. Locking the Contract: Automated Route-to-Tool Parity Invariants</h2>
      <p>Architectural principles decay quickly if they rely solely on developer discipline. If an engineer adds a new HTTP endpoint for a UI button but forgets to expose the corresponding MCP tool, the agent becomes blind to that feature.</p>
      <p>To make Capability Parity an unbreakable system invariant, our continuous integration pipeline runs an automated <strong>Route-to-Tool Parity Reflection Test</strong> on every commit:</p>

      <pre><code>// Compile-time &amp; CI reflection invariant enforcing 100% Human-Agent Parity
describe('Human-Agent Capability Parity Invariant', () =&gt; {
  it('verifies every HTTP route maps to an MCP tool or declares a NOT_FOR_AI reason', async () =&gt; {
    const routes = enumerateAllApiRoutes(app)
    const registeredMap = { ...DOMAIN_PARITY, ...ADMIN_PARITY }

    // 1. Completeness: any new route missing both an MCP tool and a NOT_FOR_AI justification fails CI
    expect(routes.filter(r =&gt; !registeredMap[r] &amp;&amp; !NOT_FOR_AI[r])).toEqual([])

    // 2. Mutual Exclusivity: no route may be simultaneously exposed to AI and listed in NOT_FOR_AI
    expect(Object.keys(registeredMap).filter(r =&gt; NOT_FOR_AI[r])).toEqual([])

    // 3. Route Bijection: verify each administrative tool action invokes the exact registered HTTP method &amp; path
    for (const [route, target] of Object.entries(ADMIN_PARITY)) {
      const [toolName, actionName] = target.split('.')
      const actionDef = findAdminToolAction(toolName, actionName)
      expect(matchesRoutePattern(route, actionDef.method, actionDef.path)).toBe(true)
    }

    // 4. Confirmation Gate Consistency: tool actions marked confirm: true must match AI_CONFIRM exactly
    expect(collectConfirmActions(ADMIN_TOOLS)).toEqual(AI_CONFIRM.sort())
  })
})</code></pre>

      <h3>5.1 Comparing Three Generations of Software Architecture</h3>
      <div class="blog-table-wrap">
        <table class="blog-table">
          <thead>
            <tr>
              <th>Architectural Dimension</th>
              <th>Legacy GUI-Only Software</th>
              <th>Screen-Scraping Agent Wrappers</th>
              <th>Heurion Dual-Interface Parity</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Agent Interaction Medium</td>
              <td>None (or read-only chat)</td>
              <td>Pixel screenshots &amp; synthetic clicks</td>
              <td><strong>100% route-paired typed MCP primitives</strong></td>
            </tr>
            <tr>
              <td>Per-Action Latency &amp; Token Cost</td>
              <td>N/A</td>
              <td>2,000–8,000 ms / heavy vision tokens</td>
              <td><strong>&lt;5 ms in-process loopback / compact JSON</strong></td>
            </tr>
            <tr>
              <td>Authorization &amp; Tenant Isolation</td>
              <td>Human session only</td>
              <td>Prone to confused-deputy UI misclicks</td>
              <td><strong>Agent Permission = User Permission (Zero-Fork)</strong></td>
            </tr>
            <tr>
              <td>Irreversible Action Safeguards</td>
              <td>Frontend modal dialog</td>
              <td>Agent can synthetically click "OK"</td>
              <td><strong>Kernel Confirmation Card (AI self-approve → 403)</strong></td>
            </tr>
            <tr>
              <td>Provenance &amp; Compliance Audit</td>
              <td>User ID only</td>
              <td>Indistinguishable from human clicks</td>
              <td><strong>Dual-track audit (<code>via: human | ai | ai-confirmed</code>)</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>When we stop treating AI agents as external screen-scrapers bolted onto legacy UI shells—and instead architect software with symmetric Human and AI-native interfaces over a unified permission kernel—we lay the true foundation for next-generation human-AI collaboration.</p>
    `,
  },
  {
    slug: 'aegis-os-transactional-agent-kernel',
    num: '03',
    category: 'aegis-os',
    category_label_zh: 'AEGIS OS · 智能体内核',
    category_label_en: 'AEGIS OS · RUST KERNEL',
    date: '2026-11-02',
    reading_time_zh: '16 分钟深读',
    reading_time_en: '16 min read',
    title_zh: 'Aegis OS 架构解构：用 Rust 构建 0.42ms 写时复制影子工作区与 AAP-1.0 人类签名租约内核',
    title_en: 'Inside Aegis OS: Building a Transactional Multi-Tenant Agent Kernel in Rust with 0.42ms CoW Workspaces & AAP-1.0 Ed25519 Leases',
    subtitle_zh: '消除自治编程智能体 90.7%–97.9% 的权限确认弹窗疲劳，同时以写时复制影子工作区、四级 LCS 三路归并与双层内核沙箱实现 0% 静默覆写与 0% 越狱率。',
    subtitle_en: 'Eliminating 90.7%–97.9% of authorization prompts in autonomous coding agents via Copy-on-Write shadow workspaces, 4-tier LCS 3-way auto-merge, dual kernel sandboxing, and offline Ed25519 capability leases.',
    summary_zh: '当多个自治智能体并发修改同一个代码仓库时，开发者往往陷入“每步弹窗点到手麻（授权疲劳）”与“开启全自动模式导致代码被静默覆写”的两难困境。本文深入解析 Aegis OS（aegis-os）的五大 Rust 核心 Crate：如何用 APFS clonefile / Linux FICLONE 实现毫秒级影子工作区派生，如何用四级 LCS Diff3 实现 98.7% 自动无冲突归并，以及如何通过 AAP-1.0 离线 Ed25519 人类签名租约重塑人机信任边界。',
    summary_en: 'When multiple autonomous agents concurrently mutate a repository, developers face a painful dilemma between constant permission prompts (authorization fatigue) and reckless live-tree overwrites. This monograph dissects Aegis OS (aegis-os) across its five Rust crates: millisecond CoW shadow workspaces via APFS clonefile and Linux FICLONE, 98.7% conflict-free 4-tier LCS Diff3 auto-merge, Seatbelt/Bubblewrap kernel confinement, and AAP-1.0 Ed25519 capability leases.',
    keywords_zh: 'Aegis OS, aegis-os, 智能体操作系统, 写时复制, APFS clonefile, 权限疲劳, AAP-1.0, Ed25519 租约, Rust',
    keywords_en: 'Aegis OS, aegis-os, Agent Operating System, Copy-on-Write Workspace, APFS clonefile, Authorization Fatigue, AAP-1.0, Ed25519 Lease, Rust',
    tags_zh: ['Rust 智能体内核', '0.42ms CoW 派生', 'AAP-1.0 签名租约', '98.7% 三路归并'],
    tags_en: ['Rust Agent Kernel', '0.42ms CoW Fork', 'AAP-1.0 Ed25519 Leases', '98.7% LCS Auto-Merge'],
    stats: [
      { val: '0.42ms', lbl_zh: 'CoW 影子工作区派生', lbl_en: 'CoW Metadata Fork' },
      { val: '97.9%', lbl_zh: '授权弹窗消除率', lbl_en: 'Prompt Reduction' },
      { val: '98.7%', lbl_zh: '四级 LCS 自动归并', lbl_en: '4-Tier LCS Auto-Merge' },
    ],
    repo_url: 'https://github.com/heurion-org/aegis-os',
    paper_url: 'https://github.com/heurion-org/aegis-os/blob/main/paper/main.pdf',
    toc: [
      { id: 'sec-auth-fatigue', zh: '01. 授权疲劳与并发踩踏：当前 Agent 运行时的两大死结', en: '01. Authorization Fatigue & Concurrent Tree Corruption' },
      { id: 'sec-cow-vfs', zh: '02. 投机执行与写时复制影子工作区（aos-vfs）', en: '02. Speculative Execution & Copy-on-Write Shadow Workspaces (aos-vfs)' },
      { id: 'sec-lcs-merge', zh: '03. 四级 LCS Diff3 三路结构化归并与沙箱预检门', en: '03. 4-Tier LCS Diff3 Auto-Merge & Sandboxed Pre-Commit Verification' },
      { id: 'sec-aap-leases', zh: '04. AAP-1.0 协议与离线 Ed25519 人类能力租约（aos-policy）', en: '04. AAP-1.0 & Offline Ed25519 Human Capability Leases (aos-policy)' },
      { id: 'sec-aegis-eval', zh: '05. 28,087 次真实工具调用与 80 项红队攻防评测', en: '05. Empirical Evaluation: 28,087 Tool Calls & 80 Red-Team Vectors' },
    ],
    body_zh: `
      <h2 id="sec-auth-fatigue">01. 授权疲劳与并发踩踏：当前 Agent 运行时的两大死结</h2>
      <p>今天的主流编程智能体（Claude Code、Cursor、Gemini CLI、Codex）默认直接运行在宿主机的真实工作目录（Host Working Tree）之上。由于每一次 <code>write_file</code> 或 <code>bash</code> 调用都会立刻产生不可逆的宿主机副作用，工具设计者被迫将安全判断推给人类开发者——每执行一条命令就弹出一个确认框。</p>
      <p>我们在对真实多智能体开发会话的统计中发现：这种“写前逐条弹窗”模式会导致严重的<strong>授权疲劳（Authorization Fatigue）</strong>——人类开发者在连续点击十几次 Approve 后会陷入机械性盲点，或者干脆开启 <code>--dangerously-skip-permissions</code>。更糟糕的是，当 3 个子智能体（Subagents）并发在同一个目录上工作时，一个智能体的半成品修改会直接污染另一个智能体的编译环境，引发灾难性的并发踩踏。</p>

      <div class="blog-callout">
        <div class="blog-callout-title">Aegis OS 的核心洞察：把“写前逐次审批”重构为“写时复制投机执行 + 提交时事务级归并”</div>
        <p>就像现代数据库用 MVCC（多版本并发控制）替代全局表锁一样，<strong>Aegis OS (<code>aegis-os</code>)</strong> 将智能体的日常文件读写与沙箱编译全部下放到零成本的<strong>写时复制影子工作区（Copy-on-Write Shadow Workspace）</strong>中实现<strong>免弹窗投机执行（Zero-Prompt Speculative Execution）</strong>，仅在将变更真正提交回宿主机（<code>workspace_commit</code>）或跨出安全边界时进行密码学租约校验。</p>
      </div>

      <h2 id="sec-cow-vfs">02. 投机执行与写时复制影子工作区（<code>aos-vfs</code>）</h2>
      <p>Aegis OS 采用纯 Rust 编写，底层由五大核心 Crate 构成：<code>aos-vfs</code>（事务型写时复制虚拟文件系统）、<code>aos-sandbox</code>（macOS Seatbelt + Linux Bubblewrap 双层内核沙箱）、<code>aos-policy</code>（五阶段策略与 Ed25519 租约引擎）、<code>aos-ipc</code>（事件驱动 A2A 消息与路径声明总线）以及 <code>aos-egress</code>（L7 零信任密钥注入与出站 DLP）。</p>

      <figure class="blog-figure">
        <svg viewBox="0 0 760 270" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Aegis OS 事务型写时复制与三路归并架构图">
          <rect x="1" y="1" width="758" height="268" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>
          <rect x="24" y="88" width="144" height="92" fill="#F2EFE9" stroke="#233E33" stroke-width="1.2"/>
          <text x="96" y="118" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">HOST REPOSITORY</text>
          <text x="96" y="140" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="11" font-weight="500">Base Snapshot (T₀)</text>
          <text x="96" y="160" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.8">APFS clonefile / FICLONE</text>

          <path d="M168 134 L204 134 L216 58 L236 58" stroke="#233E33" stroke-width="1.2"/>
          <line x1="168" y1="134" x2="236" y2="134" stroke="#233E33" stroke-width="1.2"/>
          <path d="M168 134 L204 134 L216 210 L236 210" stroke="#233E33" stroke-width="1.2"/>

          <rect x="236" y="28" width="234" height="60" fill="#FDFCF9" stroke="#C8C1B4"/>
          <text x="353" y="52" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">Agent 01 · CoW Shadow (0.42ms)</text>
          <text x="353" y="72" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">Zero-Prompt fs_edit + Seatbelt proc_exec</text>

          <rect x="236" y="104" width="234" height="60" fill="#E3ECE7" stroke="#233E33"/>
          <text x="353" y="128" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">Agent 02 · CoW Shadow (0.42ms)</text>
          <text x="353" y="148" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">coord_claim + Speculative Test Run</text>

          <rect x="236" y="180" width="234" height="60" fill="#FDFCF9" stroke="#C8C1B4"/>
          <text x="353" y="204" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">Agent 03 · CoW Shadow (0.42ms)</text>
          <text x="353" y="224" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">Isolated Upper Layer + Read-Only Deps</text>

          <path d="M470 58 L496 58 L508 134 L532 134" stroke="#233E33" stroke-width="1.2"/>
          <line x1="470" y1="134" x2="532" y2="134" stroke="#233E33" stroke-width="1.2"/>
          <path d="M470 210 L496 210 L508 134 L532 134" stroke="#233E33" stroke-width="1.2"/>

          <rect x="532" y="72" width="204" height="124" fill="#233E33" stroke="#151C19"/>
          <text x="634" y="100" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">WORKSPACE_COMMIT GATE</text>
          <line x1="532" y1="110" x2="736" y2="110" stroke="#395A4C"/>
          <text x="634" y="132" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="9">1. Auto-Rebase vs Host</text>
          <text x="634" y="150" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="9">2. 4-Tier LCS Diff3 (98.7%)</text>
          <text x="634" y="168" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="9">3. Sandboxed verify_cmd</text>
          <text x="634" y="184" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9">4. Ed25519 Lease Atomic Land</text>
        </svg>
        <figcaption>图 2：Aegis OS 基于写时复制影子工作区（CoW Shadow Workspace）的多智能体并发投机执行与四阶段原子提交流水线。</figcaption>
      </figure>

      <p>当一个智能体会话启动时，<code>aos-vfs</code> 利用操作系统原生的块级写时复制系统调用——macOS APFS 上的 <code>clonefile(2)</code> 与 Linux XFS/Btrfs/OverlayFS 上的 <code>ioctl_ficlone(2)</code>——为该智能体派生一个独立的影子工作区：</p>
      <ul>
        <li><strong>毫秒级零拷贝派生</strong>：元数据树克隆仅需 <strong>0.42 ms</strong>，完整代码库 CoW 派生在 macOS 上仅需 <strong>6.3 ms</strong>（Linux <strong>15.6 ms</strong>），比传统的 <code>cp -R</code> 快 <strong>66 倍</strong>，且未修改文件占用 <strong>0 字节</strong>额外磁盘空间。</li>
        <li><strong>只读重型依赖自动穿透</strong>：类似 <code>node_modules</code>、<code>.venv</code>、<code>target</code> 等数 GB 的构建缓存通过内核沙箱只读绑定挂载（Read-Only Bind Link）直接复用，同时阻止智能体篡改供应链依赖。</li>
        <li><strong>零弹窗投机执行</strong>：在影子工作区内，<code>fs_read</code>、<code>fs_write</code>、<code>fs_edit</code> 以及受 Seatbelt/Bubblewrap 内核强制约束的 <code>proc_exec</code> 均为 <strong>Zero-Prompt</strong>——因为无论智能体如何修改或运行测试，宿主机真实目录始终保持 100% 纯净。</li>
      </ul>

      <h2 id="sec-lcs-merge">03. 四级 LCS Diff3 三路结构化归并与沙箱预检门</h2>
      <p>当多个智能体（或人类开发者在 IDE 中）并发修改同一个仓库甚至同一个文件时，<code>workspace_commit</code> 绝不会简单地用新文件覆盖旧文件，而是基于智能体派生时的 Base 快照 $O$、当前宿主机最新状态 $H$ 与智能体影子状态 $A$，执行<strong>四级渐进式三路归并（4-Tier LCS Diff3 Auto-Merge）</strong>：</p>
      <ol>
        <li><strong>Tier 1（Fast-Forward 哈希直通）</strong>：若 $H = O$（宿主机未被并发触碰），直接以原子重命名落地；</li>
        <li><strong>Tier 2（行级标准 LCS Diff3）</strong>：基于最长公共子序列（Longest Common Subsequence）自动合并不重叠的代码块修改；</li>
        <li><strong>Tier 3（空白与缩进归一化归并）</strong>：消解因代码格式化器（Prettier / rustfmt）引发的伪冲突；</li>
        <li><strong>Tier 4（邻接无交集 Hunk 细粒度拼接）</strong>：对同一函数内相邻但互不覆盖的修改块进行亚行级验证合并，如遇真实语义冲突则立即中止并精确报告冲突行号，实现 <strong>0% 静默覆写</strong> 与 <strong>98.7% 自动无冲突归并率</strong>。</li>
      </ol>
      <p>在三路归并生成暂存树（Staging Tree）后、真正写入宿主机之前，<code>workspace_commit</code> 还支持在内核沙箱中自动执行预检命令（如 <code>verify_cmd: "cargo check --offline"</code>），若编译或测试失败则自动回滚本次提交。</p>

      <h2 id="sec-aap-leases">04. AAP-1.0 协议与离线 Ed25519 人类能力租约（<code>aos-policy</code>）</h2>
      <p>为了在“团队级治理”与“开发者零打扰”之间取得最优解，我们制定了 <strong>AAP-1.0（Aegis Application Protocol）</strong>。当智能体请求提交代码或执行高敏动作时，人类审批者（通过本地 CLI、Web 控制台或移动端审批页 <code>/aegis-cloud/approve</code>）签发的不再是一次性的“Yes”，而是一张经过 <strong>Ed25519 私钥签名、可离线验证的能力租约（Capability Lease）</strong>：</p>
      <pre><code>{
  "lease_id": "lease-9f41c8a2",
  "org_id": "heurion2",
  "agent_id": "agy-87a204",
  "scope": {
    "actions": ["workspace_commit"],
    "resources": ["apps/platform/src/http/routes/**"],
    "verify_required": true
  },
  "expires_at_ms": 1793812000000,
  "approver_pubkey": "ed25519:7f8a...3c91",
  "signature": "ed25519:4b12e9...d08a"
}</code></pre>
      <p>只要后续提交落在租约限定的路径 Glob 与时间窗口内，且通过沙箱预检，<code>aos-policy</code> 即可在本地以微秒级完成 Ed25519 验签并放行，无需再次打断人类。</p>

      <h2 id="sec-aegis-eval">05. 28,087 次真实工具调用与 80 项红队攻防评测</h2>
      <p>我们在涵盖 28,087 次真实多智能体工具调用与 80 项对抗性红队攻击向量的基准测试中对 Aegis OS 进行了全面评测：</p>
      <div class="blog-table-wrap">
        <table class="blog-table">
          <thead>
            <tr>
              <th>评测指标 (Benchmark Dimension)</th>
              <th>传统逐次确认模式 (Standard CLI)</th>
              <th>全放行无沙箱模式 (YOLO Mode)</th>
              <th>Aegis OS (CoW + AAP-1.0 Leases)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>打断式弹窗率 (Interruptive Prompt Rate)</td>
              <td>12.04% (3,381 次弹窗)</td>
              <td>0.00%（完全裸奔）</td>
              <td><strong>0.25% (消除 97.9% 授权弹窗)</strong></td>
            </tr>
            <tr>
              <td>多智能体并发修改静默覆写率</td>
              <td>41.2%（后写覆盖先写）</td>
              <td>41.2%</td>
              <td><strong>0.0% (98.7% 四级 LCS 自动归并)</strong></td>
            </tr>
            <tr>
              <td>工作区克隆耗时 (macOS APFS / Linux)</td>
              <td>418.0 ms (<code>cp -R</code>)</td>
              <td>N/A（直接改原目录）</td>
              <td><strong>6.3 ms / 15.6 ms (66× 加速)</strong></td>
            </tr>
            <tr>
              <td>80 项红队沙箱逃逸与密钥窃取攻击成功率 (ASR)</td>
              <td>37.5%（获批后共享宿主环境）</td>
              <td>100.0%</td>
              <td><strong>0.0% ASR (0.0% 误报率)</strong></td>
            </tr>
            <tr>
              <td>多智能体协作通信开销 (Push IPC vs 轮询)</td>
              <td>轮询文件锁 / 高冲突</td>
              <td>无协调</td>
              <td><strong>-99.4% IPC 轮询开销</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    `,
    body_en: `
      <h2 id="sec-auth-fatigue">01. Authorization Fatigue &amp; Concurrent Tree Corruption</h2>
      <p>Modern coding agents (Claude Code, Cursor, Gemini CLI, Codex) operate directly on the developer’s live host working tree by default. Because every <code>write_file</code> or <code>bash</code> invocation immediately mutates host state, tool builders push safety decisions onto the human operator via synchronous confirmation prompts.</p>
      <p>Across real multi-agent engineering sessions, this per-write prompting model induces severe <strong>Authorization Fatigue</strong>: developers either habituate into rubber-stamping prompts without inspection or enable <code>--dangerously-skip-permissions</code>. Worse still, when multiple subagents execute concurrently on a shared directory, one agent’s partial edits corrupt another agent’s build state, causing silent data loss and race conditions.</p>

      <div class="blog-callout">
        <div class="blog-callout-title">Core Insight of Aegis OS: Replace Per-Write Prompts with Speculative CoW Execution + Transactional Commit</div>
        <p>Just as modern databases replaced coarse table locks with MVCC (Multi-Version Concurrency Control), <strong>Aegis OS (<code>aegis-os</code>)</strong> isolates everyday agent file mutations and test executions inside zero-cost <strong>Copy-on-Write Shadow Workspaces</strong> for <strong>Zero-Prompt Speculative Execution</strong>—enforcing cryptographic human-in-the-loop leases only at the transactional <code>workspace_commit</code> boundary.</p>
      </div>

      <h2 id="sec-cow-vfs">02. Speculative Execution &amp; Copy-on-Write Shadow Workspaces (<code>aos-vfs</code>)</h2>
      <p>Written in Rust, Aegis OS comprises five modular kernel crates: <code>aos-vfs</code> (transactional CoW virtual filesystem), <code>aos-sandbox</code> (macOS Seatbelt + Linux Bubblewrap kernel confinement), <code>aos-policy</code> (5-stage evaluator &amp; Ed25519 lease engine), <code>aos-ipc</code> (event-driven A2A mailbox &amp; path claims), and <code>aos-egress</code> (L7 zero-trust secret injection &amp; outbound DLP).</p>

      <figure class="blog-figure">
        <svg viewBox="0 0 760 270" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Aegis OS Transactional Copy-on-Write and 3-Way Merge Architecture">
          <rect x="1" y="1" width="758" height="268" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>
          <rect x="24" y="88" width="144" height="92" fill="#F2EFE9" stroke="#233E33" stroke-width="1.2"/>
          <text x="96" y="118" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">HOST REPOSITORY</text>
          <text x="96" y="140" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="11" font-weight="500">Base Snapshot (T₀)</text>
          <text x="96" y="160" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.8">APFS clonefile / FICLONE</text>

          <path d="M168 134 L204 134 L216 58 L236 58" stroke="#233E33" stroke-width="1.2"/>
          <line x1="168" y1="134" x2="236" y2="134" stroke="#233E33" stroke-width="1.2"/>
          <path d="M168 134 L204 134 L216 210 L236 210" stroke="#233E33" stroke-width="1.2"/>

          <rect x="236" y="28" width="234" height="60" fill="#FDFCF9" stroke="#C8C1B4"/>
          <text x="353" y="52" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">Agent 01 · CoW Shadow (0.42ms)</text>
          <text x="353" y="72" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">Zero-Prompt fs_edit + Seatbelt proc_exec</text>

          <rect x="236" y="104" width="234" height="60" fill="#E3ECE7" stroke="#233E33"/>
          <text x="353" y="128" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">Agent 02 · CoW Shadow (0.42ms)</text>
          <text x="353" y="148" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">coord_claim + Speculative Test Run</text>

          <rect x="236" y="180" width="234" height="60" fill="#FDFCF9" stroke="#C8C1B4"/>
          <text x="353" y="204" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">Agent 03 · CoW Shadow (0.42ms)</text>
          <text x="353" y="224" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">Isolated Upper Layer + Read-Only Deps</text>

          <path d="M470 58 L496 58 L508 134 L532 134" stroke="#233E33" stroke-width="1.2"/>
          <line x1="470" y1="134" x2="532" y2="134" stroke="#233E33" stroke-width="1.2"/>
          <path d="M470 210 L496 210 L508 134 L532 134" stroke="#233E33" stroke-width="1.2"/>

          <rect x="532" y="72" width="204" height="124" fill="#233E33" stroke="#151C19"/>
          <text x="634" y="100" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">WORKSPACE_COMMIT GATE</text>
          <line x1="532" y1="110" x2="736" y2="110" stroke="#395A4C"/>
          <text x="634" y="132" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="9">1. Auto-Rebase vs Host</text>
          <text x="634" y="150" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="9">2. 4-Tier LCS Diff3 (98.7%)</text>
          <text x="634" y="168" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="9">3. Sandboxed verify_cmd</text>
          <text x="634" y="184" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9">4. Ed25519 Lease Atomic Land</text>
        </svg>
        <figcaption>Figure 2: Aegis OS multi-agent speculative execution in CoW shadow workspaces and 4-stage atomic commit pipeline.</figcaption>
      </figure>

      <p>When an agent spawns, <code>aos-vfs</code> invokes OS-native copy-on-write primitives—<code>clonefile(2)</code> on macOS APFS and <code>ioctl_ficlone(2)</code> on Linux—to provision an isolated shadow workspace:</p>
      <ul>
        <li><strong>Sub-Millisecond Metadata Fork</strong>: Forking workspace metadata takes <strong>0.42 ms</strong>, and cloning a full repository takes <strong>6.3 ms</strong> on macOS (<strong>15.6 ms</strong> on Linux)—<strong>66× faster</strong> than <code>cp -R</code> with zero duplicate disk blocks for unmodified files.</li>
        <li><strong>Read-Only Dependency Auto-Linking</strong>: Multi-gigabyte directories such as <code>node_modules</code>, <code>.venv</code>, and <code>target</code> are linked read-only into the sandbox, preventing supply-chain tampering while enabling instant builds.</li>
        <li><strong>Zero-Prompt Speculative Execution</strong>: Inside the shadow workspace, <code>fs_read</code>, <code>fs_write</code>, <code>fs_edit</code>, and kernel-confined <code>proc_exec</code> require zero user prompts because the host tree remains completely untouched until commit.</li>
      </ul>

      <h2 id="sec-lcs-merge">03. 4-Tier LCS Diff3 Auto-Merge &amp; Sandboxed Pre-Commit Verification</h2>
      <p>Upon <code>workspace_commit</code>, Aegis OS reconciles the agent’s base snapshot $O$, the current live host state $H$, and the agent’s shadow state $A$ via a <strong>4-Tier Longest Common Subsequence (LCS) Diff3 Engine</strong>:</p>
      <ol>
        <li><strong>Tier 1 (Fast-Forward Hash Match)</strong>: If $H = O$, changes stage immediately via atomic rename;</li>
        <li><strong>Tier 2 (Standard Line-Level LCS Diff3)</strong>: Non-overlapping hunks edited concurrently by human or peer agents merge automatically;</li>
        <li><strong>Tier 3 (Whitespace &amp; Indentation Normalized Merge)</strong>: Resolves false conflicts caused by code formatters;</li>
        <li><strong>Tier 4 (Adjacent Non-Overlapping Sub-Hunk Splicing)</strong>: Merges adjacent edits within the same block while halting on true semantic collisions—achieving <strong>0% silent overwrites</strong> and a <strong>98.7% conflict-free auto-merge rate</strong>.</li>
      </ol>
      <p>Before touching the host tree, <code>workspace_commit</code> optionally executes a kernel-sandboxed <code>verify_cmd</code> (e.g., <code>cargo test</code>) against the merged staging tree, aborting the commit if verification fails.</p>

      <h2 id="sec-aap-leases">04. AAP-1.0 &amp; Offline Ed25519 Human Capability Leases (<code>aos-policy</code>)</h2>
      <p>Under the <strong>Aegis Application Protocol (AAP-1.0)</strong>, human approvals issue cryptographically signed, offline-verifiable <strong>Ed25519 Capability Leases</strong> scoped by organization, agent identity, action, resource glob, and TTL:</p>
      <pre><code>{
  "lease_id": "lease-9f41c8a2",
  "org_id": "heurion2",
  "agent_id": "agy-87a204",
  "scope": {
    "actions": ["workspace_commit"],
    "resources": ["apps/platform/src/http/routes/**"],
    "verify_required": true
  },
  "expires_at_ms": 1793812000000,
  "approver_pubkey": "ed25519:7f8a...3c91",
  "signature": "ed25519:4b12e9...d08a"
}</code></pre>

      <h2 id="sec-aegis-eval">05. Empirical Evaluation: 28,087 Tool Calls &amp; 80 Red-Team Vectors</h2>
      <div class="blog-table-wrap">
        <table class="blog-table">
          <thead>
            <tr>
              <th>Benchmark Dimension</th>
              <th>Standard Per-Write Prompting</th>
              <th>Unconfined Auto-Approve (YOLO)</th>
              <th>Aegis OS (CoW + AAP-1.0 Leases)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Interruptive Prompt Rate (IPR)</td>
              <td>12.04% (3,381 prompts)</td>
              <td>0.00% (unconfined)</td>
              <td><strong>0.25% (97.9% prompt reduction)</strong></td>
            </tr>
            <tr>
              <td>Concurrent Edit Silent Overwrite Rate</td>
              <td>41.2% (last-writer-wins)</td>
              <td>41.2%</td>
              <td><strong>0.0% (98.7% 4-Tier LCS auto-merge)</strong></td>
            </tr>
            <tr>
              <td>Workspace Provisioning Latency (macOS / Linux)</td>
              <td>418.0 ms (<code>cp -R</code>)</td>
              <td>N/A (mutates host directly)</td>
              <td><strong>6.3 ms / 15.6 ms (66× speedup)</strong></td>
            </tr>
            <tr>
              <td>Red-Team Escape &amp; Exfiltration ASR (80 Vectors)</td>
              <td>37.5% (post-approval host access)</td>
              <td>100.0%</td>
              <td><strong>0.0% ASR (0.0% false positives)</strong></td>
            </tr>
            <tr>
              <td>Multi-Agent Coordination Overhead</td>
              <td>Polling file locks</td>
              <td>Uncoordinated</td>
              <td><strong>-99.4% IPC polling overhead</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    `,
  },
  {
    slug: 'cross-modal-self-evolution-clinical-deep-review',
    num: '04',
    category: 'self-evolution',
    category_label_zh: 'HEURION 2.0 · 双轨自演进',
    category_label_en: 'HEURION 2.0 · SELF-EVOLVING AI',
    date: '2026-10-29',
    reading_time_zh: '15 分钟深读',
    reading_time_en: '15 min read',
    title_zh: '跨模态双轨自演进与四阶段临床深度审稿：让临床 AI 从医生的批注抗辩（{#c:id}）中持续学习',
    title_en: 'Cross-Modal Dual-Track Self-Evolution & Four-Stage Clinical Deep Review: Teaching AI Agents from Physician Rebuttals ({#c:id})',
    subtitle_zh: '结合腐化重建自监督技能训练（Track A）与零模板程序性守卫合成（Track B），将临床深度审稿批注转化为可复用、零患者数值污染的科室级认知资产。',
    subtitle_en: 'Combining self-supervised corruption-and-reconstruction skill training (Track A) with zero-template procedural rule synthesis (Track B) to turn physician review rebuttals into zero-leakage institutional memory.',
    summary_zh: '静态提示词工程在跨模态临床科研（3D 医学影像、生物统计、学术手稿、汇报幻灯片、同行审稿）中很快会遇到准确率天花板：智能体会反复触发相同的结构守卫错误，或在单臂肿瘤试验等专科设计上产生大量假警报。本文详解 Heurion 2.0 的四阶段临床深度审稿流水线与双轨自演进记忆引擎，实现写前守卫拒绝率下降 62.5%（未见测试集下降 75.0%）且单轮未证实记忆污染率为 0.0%。',
    summary_en: 'Static prompt engineering plateaus across multi-modal clinical research (3D imaging, biostatistics, manuscripts, slide decks, and peer review): agents repeat structural guard errors and trigger false alarms on specialty study designs. This article presents Heurion 2.0’s Four-Stage Clinical Deep Review pipeline and Dual-Track Self-Evolving Memory Engine, reducing guard rejections by 62.5% overall (75.0% held-out) with 0.0% single-turn memory pollution.',
    keywords_zh: '自演进记忆, 临床深度审稿, 双轨自演进, Track A 技能训练, Track B 程序性守卫, Heurion 2.0, 批注抗辩',
    keywords_en: 'Self-Evolving Memory, Clinical Deep Review, Dual-Track Self-Evolution, Track A Skill Training, Track B Procedural Guards, Heurion 2.0, Physician Rebuttal',
    tags_zh: ['双轨自演进', '四阶段深度审稿', '批注驱动收窄 {#c:id}', '0.0% 记忆污染'],
    tags_en: ['Dual-Track Evolution', '4-Stage Deep Review', 'Comment Rebuttal {#c:id}', '0.0% Memory Pollution'],
    stats: [
      { val: '-75.0%', lbl_zh: '未见集守卫拒绝降幅', lbl_en: 'Held-Out Reject Drop' },
      { val: '0.0%', lbl_zh: '患者具体数值污染率', lbl_en: 'Instance Pollution' },
      { val: '+161%', lbl_zh: '跨模态对齐增益', lbl_en: 'Cross-Modal Alignment' },
    ],
    repo_url: 'https://github.com/heurion-org/heurion',
    paper_url: 'https://github.com/heurion-org/heurion/blob/main/paper/main.pdf',
    toc: [
      { id: 'sec-static-ceiling', zh: '01. 静态 Agent 的天花板：跨五模态科研中的重复犯错与专科假警报', en: '01. The Static Agent Ceiling Across Five Clinical Modalities' },
      { id: 'sec-four-stage-review', zh: '02. 四阶段临床深度审稿与四级正交证据对齐（Table / Fulltext / Abstract）', en: '02. Four-Stage Clinical Deep Review & Orthogonal Evidence Tiers' },
      { id: 'sec-track-a', zh: '03. Track A（认知层）：自监督腐化重建与批注驱动技能收窄（{#c:id}）', en: '03. Track A (Cognitive): Self-Supervised Reconstruction & Comment-Driven Narrowing' },
      { id: 'sec-track-b', zh: '04. Track B（程序层）：零模板写前守卫规则合成与归因过滤', en: '04. Track B (Procedural): Zero-Template Pre-Flight Rule Synthesis' },
      { id: 'sec-evolution-eval', zh: '05. Held-Out 未见测试集与 20 篇真实 PMC 临床论文评测', en: '05. Empirical Results on Held-Out Benchmarks & 20 PMC Clinical Trials' },
    ],
    body_zh: `
      <h2 id="sec-static-ceiling">01. 静态 Agent 的天花板：跨五模态科研中的重复犯错与专科假警报</h2>
      <p>真实的临床科研从来不是单一的文本续写，而是横跨五大高严谨度模态的闭环工程：<strong>3D 医学影像量化（<code>imaging</code>，如 RECIST 1.1 靶病灶追踪与 L3 骨骼肌指数 SMI）</strong>、<strong>队列生物统计建模（<code>datasets</code>）</strong>、<strong>双表面论文手稿（<code>doc</code>）</strong>、<strong>多学科会诊与学术汇报（<code>deck</code>）</strong>以及<strong>深度同行评审（<code>claims</code>）</strong>。</p>
      <p>在实际部署中，不具备自演进能力的静态 Agent 会暴露出两大痛点：（1）在跨会话写作中反复触发同一类结构化写前守卫拒绝；（2）在执行临床审稿时，机械套用通用 RCT 规则，对单臂 II 期肿瘤试验或回顾性罕见病队列报出大量“缺少随机化对照组”的专科假警报（False Alarms）。</p>

      <h2 id="sec-four-stage-review">02. 四阶段临床深度审稿与四级正交证据对齐</h2>
      <p>Heurion 2.0 启发自形式化数学证明助手的验证思想，在 <code>apps/platform/src/claims/service.ts</code> 中构建了针对医学手稿的<strong>四阶段临床深度审稿流水线（Four-Stage Clinical Deep Review）</strong>：</p>
      <ol>
        <li><strong>Stage 1 · 外部文献四级证据对齐（External Citation Grounding）</strong>：拉取 PubMed 摘要与 PMC 开放获取全文 XML（含原文表格），将文内断言划分为 <code>table</code>（原文表格精确匹配）、<code>fulltext</code>（正文段落支持）、<code>abstract</code>（摘要支持）与 <code>none</code>（无据或数值相悖）四级正交覆盖度。</li>
        <li><strong>Stage 2 · 内部文-表-图算术一致性核查（Internal Arithmetic Audit）</strong>：自动交叉比对正文 Results 中的样本量 $N$、百分比、HR/OR 置信区间是否与文内 Table 1 及 CONSORT 纳排漏斗完全闭合。</li>
        <li><strong>Stage 3 · 生物统计方法学审计（Biostatistical Methodology Audit）</strong>：核查偏态分布连续变量是否误用均值±标准差、小样本分类变量是否遗漏 Fisher 精确检验、观察性队列是否补充未测量混杂因素 E-value 敏感性分析。</li>
        <li><strong>Stage 4 · 临床夸大偏倚（Spin Bias）与报告规范核查</strong>：识别 P &gt; 0.05 时仍使用“趋势显著”等夸大表述，并在对应段落上直接锚定行内批注线程 <code>{#c:id}</code>。</li>
      </ol>

      <figure class="blog-figure">
        <svg viewBox="0 0 760 260" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Heurion 2.0 跨模态双轨自演进架构图">
          <rect x="1" y="1" width="758" height="258" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>
          <rect x="24" y="28" width="206" height="92" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="127" y="52" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">EXEMPLARS &amp; {#c:id} REBUTTALS</text>
          <text x="127" y="74" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">科室黄金范例 + 医生批注抗辩</text>
          <text x="127" y="96" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">Instance De-ID Guard (0.0% Leak)</text>

          <rect x="24" y="140" width="206" height="92" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="127" y="164" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">EXECUTION ERROR TRAJECTORIES</text>
          <text x="127" y="186" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">守卫拒绝 → 恢复成功对比对</text>
          <text x="127" y="208" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">Commit-on-Evidence (≥2 Signals)</text>

          <line x1="230" y1="74" x2="278" y2="74" stroke="#233E33" stroke-width="1.4"/>
          <line x1="230" y1="186" x2="278" y2="186" stroke="#8F5638" stroke-width="1.4"/>

          <rect x="278" y="28" width="234" height="92" fill="#E3ECE7" stroke="#233E33"/>
          <text x="395" y="52" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">TRACK A · COGNITIVE SKILL ENGINE</text>
          <text x="395" y="74" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">腐化重建自监督训练 + Scope Narrow</text>
          <text x="395" y="96" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">Ms+155% · St 0→0.612 · Dk+161%</text>

          <rect x="278" y="140" width="234" height="92" fill="#233E33" stroke="#151C19"/>
          <text x="395" y="164" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">TRACK B · PROCEDURAL GUARD ENGINE</text>
          <text x="395" y="186" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">零模板写前规则合成与效用卫生淘汰</text>
          <text x="395" y="208" text-anchor="middle" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.5">-75.0% Held-Out Guard Rejections</text>

          <line x1="512" y1="74" x2="554" y2="130" stroke="#233E33" stroke-width="1.4"/>
          <line x1="512" y1="186" x2="554" y2="130" stroke="#233E33" stroke-width="1.4"/>

          <rect x="554" y="64" width="182" height="132" fill="#EFECE4" stroke="#151C19"/>
          <text x="645" y="94" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">VERSIONED GOVERNANCE</text>
          <line x1="554" y1="104" x2="736" y2="104" stroke="#C8C1B4"/>
          <text x="645" y="128" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• 跨模态零负迁移门禁</text>
          <text x="645" y="148" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• 归因过滤信用分配</text>
          <text x="645" y="168" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">• 100% 写前覆盖率</text>
        </svg>
        <figcaption>图 3：Heurion 2.0 跨模态双轨自演进引擎（Track A 认知技能演进 + Track B 零模板程序性守卫合成）。</figcaption>
      </figure>

      <h2 id="sec-track-a">03. Track A（认知层）：自监督腐化重建与批注驱动技能收窄（<code>{#c:id}</code>）</h2>
      <p>为了让智能体学会特定科室的学术规范，<code>SkillTrainingService</code>（Track A）设计了两条核心学习通路：</p>
      <ul>
        <li><strong>自监督腐化-重建训练（Corruption-and-Reconstruction Skill Training）</strong>：给定科室导入的黄金范例（Gold Exemplar），系统自动将其降级腐化为平庸草稿，令 Agent 尝试重建，并通过对比黄金范例与重建稿的差距自动提炼可复用的方法学技能树，同时经过<strong>实例脱敏守卫（Instance De-Identification Guard）</strong>剔除一切具体患者数值与 P 值，确保 <strong>0.0% 实例数值污染</strong>。</li>
        <li><strong>批注抗辩驱动的技能适用域收窄（Comment-Driven Scope Narrowing）</strong>：当四阶段深度审稿在文档中挂出批注 <code>{#c:id}</code>，而临床医生回复驳回（Rebuttal，例如指出“本研究为单臂 II 期临床试验，按规范豁免对照组”）时，系统自动将该驳回转化为对该审稿规则适用域的收窄（<code>narrow</code>），在后续同类研究中精准抑制假警报。</li>
      </ul>

      <h2 id="sec-track-b">04. Track B（程序层）：零模板写前守卫规则合成与归因过滤</h2>
      <p>与认知技能正交，<code>ProceduralHarnessService</code>（Track B）专门从智能体的工具报错与恢复轨迹（Guard Reject $\\to$ Successful Retry）中自主合成写前预检规则：</p>
      <ul>
        <li><strong>循证提交门槛（Commit-on-Evidence）</strong>：单次偶发报错绝不直接写入规则库（保证 <strong>0.0% 单轮噪声记忆污染</strong>），只有当同一失败模式在至少 2 个独立证据对中复现并成功恢复时才触发合成；</li>
        <li><strong>归因过滤与在线效用卫生（Attribution-Filtered Hygiene）</strong>：每次规则激活后追踪目标家族错误是否真正收敛，自动归档低效规则。</li>
      </ul>

      <h2 id="sec-evolution-eval">05. Held-Out 未见测试集与 20 篇真实 PMC 临床论文评测</h2>
      <div class="blog-table-wrap">
        <table class="blog-table">
          <thead>
            <tr>
              <th>评测任务与指标 (Evaluation Task)</th>
              <th>静态基线 (Static Agent)</th>
              <th>单轨演进 (Track A or B Only)</th>
              <th>Heurion 2.0 双轨自演进 (Full)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Held-Out 未见测试集写前守卫拒绝率降幅</td>
              <td>0.0% (Baseline)</td>
              <td>-37.5%</td>
              <td><strong>-75.0% (整体 -62.5%)</strong></td>
            </tr>
            <tr>
              <td>单轮未证实噪声记忆污染率 (Memory Pollution)</td>
              <td>N/A</td>
              <td>18.2% (无门槛直写)</td>
              <td><strong>0.0% (Commit-on-Evidence)</strong></td>
            </tr>
            <tr>
              <td>黄金范例具体患者数值泄漏率</td>
              <td>N/A</td>
              <td>14.5% (未开启实例脱敏)</td>
              <td><strong>0.0% (Instance De-ID Guard)</strong></td>
            </tr>
            <tr>
              <td>跨模态方法学对齐增益 (论文 / 统计 / 幻灯片)</td>
              <td>1.00× (基准)</td>
              <td>+82% / +0.34 / +94%</td>
              <td><strong>+155% / +0.612 / +161% (零负迁移)</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    `,
    body_en: `
      <h2 id="sec-static-ceiling">01. The Static Agent Ceiling Across Five Clinical Modalities</h2>
      <p>Authentic clinical research spans five tightly coupled modalities: <strong>3D volumetric medical imaging (<code>imaging</code>, RECIST 1.1 longitudinal tracking &amp; L3 skeletal muscle index)</strong>, <strong>cohort biostatistics (<code>datasets</code>)</strong>, <strong>dual-surface manuscripts (<code>doc</code>)</strong>, <strong>academic presentation decks (<code>deck</code>)</strong>, and <strong>deep peer review (<code>claims</code>)</strong>.</p>
      <p>In production deployments, static agents hit two fundamental bottlenecks: (1) they repeatedly trigger identical structural guard rejections across sessions, and (2) during manuscript review, they apply rigid general rules that produce high false-alarm rates on specialized clinical designs (such as single-arm Phase II oncology trials).</p>

      <h2 id="sec-four-stage-review">02. Four-Stage Clinical Deep Review &amp; Orthogonal Evidence Tiers</h2>
      <p>Inspired by formal proof assistants, Heurion 2.0 implements a <strong>Four-Stage Clinical Deep Review</strong> pipeline inside <code>apps/platform/src/claims/service.ts</code>:</p>
      <ol>
        <li><strong>Stage 1 · External Citation Grounding</strong>: Aligns manuscript sentences against NCBI PubMed abstracts and PubMed Central (PMC) full-text XML (including parsed tables), classifying evidence into four orthogonal coverage tiers: <code>table</code>, <code>fulltext</code>, <code>abstract</code>, and <code>none</code>.</li>
        <li><strong>Stage 2 · Internal Prose-to-Table Arithmetic Audit</strong>: Cross-checks sample sizes $N$, percentages, and HR/OR confidence intervals in prose against Table 1 and CONSORT flowcharts.</li>
        <li><strong>Stage 3 · Biostatistical Methodology Audit</strong>: Verifies normality branching (Mean±SD vs. Median [IQR]), exact tests for sparse cells, and E-value sensitivity analysis for unmeasured confounding in observational cohorts.</li>
        <li><strong>Stage 4 · Clinical Spin Bias &amp; Guideline Compliance</strong>: Flags spin language when $P &gt; 0.05$ and anchors actionable review threads <code>{#c:id}</code> directly onto the target CRDT block.</li>
      </ol>

      <figure class="blog-figure">
        <svg viewBox="0 0 760 260" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Heurion 2.0 Cross-Modal Dual-Track Self-Evolution Diagram">
          <rect x="1" y="1" width="758" height="258" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>
          <rect x="24" y="28" width="206" height="92" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="127" y="52" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">EXEMPLARS &amp; {#c:id} REBUTTALS</text>
          <text x="127" y="74" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">Gold Exemplars + Physician Replies</text>
          <text x="127" y="96" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">Instance De-ID Guard (0.0% Leak)</text>

          <rect x="24" y="140" width="206" height="92" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="127" y="164" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">EXECUTION ERROR TRAJECTORIES</text>
          <text x="127" y="186" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">Guard Reject → Recovery Pairs</text>
          <text x="127" y="208" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">Commit-on-Evidence (≥2 Signals)</text>

          <line x1="230" y1="74" x2="278" y2="74" stroke="#233E33" stroke-width="1.4"/>
          <line x1="230" y1="186" x2="278" y2="186" stroke="#8F5638" stroke-width="1.4"/>

          <rect x="278" y="28" width="234" height="92" fill="#E3ECE7" stroke="#233E33"/>
          <text x="395" y="52" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">TRACK A · COGNITIVE SKILL ENGINE</text>
          <text x="395" y="74" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">Self-Supervised Rebuild + Narrowing</text>
          <text x="395" y="96" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">Ms+155% · St 0→0.612 · Dk+161%</text>

          <rect x="278" y="140" width="234" height="92" fill="#233E33" stroke="#151C19"/>
          <text x="395" y="164" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">TRACK B · PROCEDURAL GUARD ENGINE</text>
          <text x="395" y="186" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">Zero-Template Pre-Flight Synthesis</text>
          <text x="395" y="208" text-anchor="middle" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.5">-75.0% Held-Out Guard Rejections</text>

          <line x1="512" y1="74" x2="554" y2="130" stroke="#233E33" stroke-width="1.4"/>
          <line x1="512" y1="186" x2="554" y2="130" stroke="#233E33" stroke-width="1.4"/>

          <rect x="554" y="64" width="182" height="132" fill="#EFECE4" stroke="#151C19"/>
          <text x="645" y="94" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">VERSIONED GOVERNANCE</text>
          <line x1="554" y1="104" x2="736" y2="104" stroke="#C8C1B4"/>
          <text x="645" y="128" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• Zero-Negative-Transfer Gate</text>
          <text x="645" y="148" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• Attribution Credit Filter</text>
          <text x="645" y="168" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">• 100% Pre-Flight Coverage</text>
        </svg>
        <figcaption>Figure 3: Heurion 2.0 Cross-Modal Dual-Track Self-Evolution Engine (Track A Cognitive Skills + Track B Procedural Pre-Flight Synthesis).</figcaption>
      </figure>

      <h2 id="sec-track-a">03. Track A (Cognitive): Self-Supervised Reconstruction &amp; Comment-Driven Narrowing</h2>
      <ul>
        <li><strong>Self-Supervised Corruption-and-Reconstruction Training</strong>: Given a department gold exemplar, <code>SkillTrainingService</code> synthetically degrades the artifact into a naive draft, tasks the agent with reconstructing it, and distills the residual delta into domain-scoped skills. An <strong>Instance De-Identification Guard</strong> strips all cohort-specific numbers and patient values, guaranteeing <strong>0.0% instance leakage</strong>.</li>
        <li><strong>Comment-Driven Scope Narrowing (<code>{#c:id}</code>)</strong>: When a clinician replies to an inline review comment <code>{#c:id}</code> with a methodological rebuttal (e.g., explaining a single-arm trial exemption), the engine automatically narrows the skill’s applicability scope (<code>narrow</code>), suppressing repeat false alarms on future studies.</li>
      </ul>

      <h2 id="sec-track-b">04. Track B (Procedural): Zero-Template Pre-Flight Rule Synthesis</h2>
      <p><code>ProceduralHarnessService</code> (Track B) observes <em>Guard Rejection $\\to$ Recovery</em> pairs during live execution. Rather than polluting memory on single-turn noise, it enforces a <strong>Commit-on-Evidence</strong> threshold ($\\ge 2$ corroborated recovery trajectories) and attribution-filtered credit assignment to synthesize executable pre-flight checks.</p>

      <h2 id="sec-evolution-eval">05. Empirical Results on Held-Out Benchmarks &amp; 20 PMC Clinical Trials</h2>
      <div class="blog-table-wrap">
        <table class="blog-table">
          <thead>
            <tr>
              <th>Evaluation Metric</th>
              <th>Static Agent Baseline</th>
              <th>Single-Track Only</th>
              <th>Heurion 2.0 Dual-Track Evolution</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Held-Out Pre-Write Guard Rejection Reduction</td>
              <td>0.0% (Baseline)</td>
              <td>-37.5%</td>
              <td><strong>-75.0% (-62.5% overall)</strong></td>
            </tr>
            <tr>
              <td>Single-Turn Uncorroborated Memory Pollution</td>
              <td>N/A</td>
              <td>18.2% (unfiltered write)</td>
              <td><strong>0.0% (Commit-on-Evidence)</strong></td>
            </tr>
            <tr>
              <td>Patient-Specific Numerical Leakage in Skills</td>
              <td>N/A</td>
              <td>14.5% (without De-ID gate)</td>
              <td><strong>0.0% (Instance De-ID Guard)</strong></td>
            </tr>
            <tr>
              <td>Cross-Modal Alignment Gain (Doc / Stats / Deck)</td>
              <td>1.00×</td>
              <td>+82% / +0.34 / +94%</td>
              <td><strong>+155% / +0.612 / +161% (0 negative transfer)</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    `,
  },
  {
    slug: 'zero-leakage-phi-gatekeeper-and-uomp',
    num: '05',
    category: 'privacy-uomp',
    category_label_zh: '隐私合规 · PHI & UOMP 协议',
    category_label_en: 'PRIVACY & PROTOCOL · UOMP',
    date: '2026-10-24',
    reading_time_zh: '13 分钟深读',
    reading_time_en: '13 min read',
    title_zh: '零外泄临床 AI 与 UOMP 记忆协议：从本地 PHI 隐私守门员到可审计的智能体记忆同意',
    title_en: 'Zero-Leakage Clinical AI & UOMP: From Local PHI Gatekeeping (MOD 11-2 / Luhn) to Auditable Agent Memory Consent',
    subtitle_zh: '为什么医疗与个人智能体不能只靠正则表达式脱敏：结合校验和确定性 PHI 拦截、知家 PHR 跨成员红线、人机权限对称性与 UOMP 开放记忆同意协议。',
    subtitle_en: 'Combining mathematical checksum PHI redaction, Zhijia PHR cross-member red-lines, formally verified Human-AI Permission Symmetry, and the User-Owned Memory Protocol (UOMP).',
    summary_zh: '在临床病历结构化与家庭健康顾问（知家 PHR）场景中，数据隐私面临双重威胁：一是原始受保护健康信息（PHI）在发送给大模型时外泄；二是智能体在未经授权的情况下永久驻留或跨成员串味敏感病史。本文深入解析 Heurion 2.0 的确定性本地 PHI 守门员（MOD 11-2 / Luhn 校验和，1,200 样本 100% 拦截，0.85ms/篇）、MCP 进程内同源权限对称性，以及 Aegis OS 执行的 UOMP 开放记忆同意协议。',
    summary_en: 'Clinical and personal health AI systems face dual privacy threats: raw Protected Health Information (PHI) exfiltration to external LLM APIs and unconsented cross-context memory retention. This article details Heurion 2.0’s mathematical checksum PHI gatekeeper (100% recall across 1,200 test cases at 0.85ms/doc), in-process Human-AI Permission Symmetry, and the User-Owned Memory Protocol (UOMP) enforced by Aegis OS.',
    keywords_zh: 'PHI 脱敏, HIPAA Safe Harbor, MOD 11-2, 知家 PHR, UOMP 协议, 记忆同意协议, 人机权限对称, Heurion 2.0',
    keywords_en: 'PHI De-identification, HIPAA Safe Harbor, MOD 11-2, Zhijia PHR, UOMP Protocol, Memory Consent Protocol, Permission Symmetry, Heurion 2.0',
    tags_zh: ['MOD 11-2 校验和脱敏', 'UOMP 记忆协议', '知家 PHR 零串味', '人机权限对称'],
    tags_en: ['MOD 11-2 PHI Redaction', 'UOMP Memory Protocol', 'PHR Cross-Member Guard', 'Permission Symmetry'],
    stats: [
      { val: '100%', lbl_zh: '1,200 样本 PHI 拦截', lbl_en: 'PHI Recall (1,200 Cases)' },
      { val: '0.85ms', lbl_zh: '单篇本地扫描延迟', lbl_en: 'Local Scan Latency' },
      { val: '40/40', lbl_zh: 'PHR 跨成员串味阻断', lbl_en: 'PHR Leak Block Rate' },
    ],
    repo_url: 'https://github.com/heurion-org/aegis-os',
    paper_url: 'https://www.uomp.org/spec/',
    toc: [
      { id: 'sec-dual-privacy-threat', zh: '01. 医疗与个人智能体的双重隐私威胁', en: '01. The Dual Privacy Threat in Clinical & Personal Agents' },
      { id: 'sec-checksum-phi', zh: '02. 告别盲目正则：基于 MOD 11-2 与 Luhn 校验和的确定性 PHI 守门员', en: '02. Beyond Naive Regex: Deterministic Checksum PHI Gatekeeping' },
      { id: 'sec-phr-symmetry', zh: '03. 知家 PHR 跨成员红线与形式化人机权限对称（Permission Symmetry）', en: '03. Zhijia PHR Red-Lines & Formally Verified Permission Symmetry' },
      { id: 'sec-uomp-protocol', zh: '04. UOMP（User-Owned Memory Protocol）：可撤销、可审计的记忆契约', en: '04. UOMP: Revocable, Cryptographically Auditable Memory Consent' },
    ],
    body_zh: `
      <h2 id="sec-dual-privacy-threat">01. 医疗与个人智能体的双重隐私威胁</h2>
      <p>当临床医生将出院小结导入工作台提取科研变量，或家庭用户使用“知家（Zhijia PHR）”管理父母与子女的体检档案时，隐私防线必须同时回答两个严苛问题：</p>
      <ol>
        <li><strong>入站防外泄（Inbound Zero-Leakage）</strong>：如何在不把患者真实姓名、18 位身份证号、住院号、手机号发送给外部公有云大模型的前提下，完成高精度的病历结构化与 Table 1 统计？</li>
        <li><strong>出站防串味与记忆可控（Outbound Isolation &amp; Memory Consent）</strong>：如何从架构上保证 AI 绝不会拥有超越当前登录用户的越权数据库访问能力，且用户随时可以按范围撤销智能体对特定健康记忆的读写授权？</li>
      </ol>

      <h2 id="sec-checksum-phi">02. 告别盲目正则：基于 MOD 11-2 与 Luhn 校验和的确定性 PHI 守门员</h2>
      <p>在医学文本中，单纯依赖宽泛的正则表达式（如匹配连续数字）会把 PubMed PMID（8 位数字）、高精度检验数值或 DICOM Series UID 误判为电话号码或证件号。Heurion 2.0 在 <code>apps/platform/src/ops/phi-scan.ts</code> 中实现了结合<strong>数学校验和与临床语境锚点</strong>的多阶段本地扫描器：</p>
      <ul>
        <li><strong>ISO 7064 MOD 11-2 身份证校验</strong>：对 18 位中国居民身份证号严格验证行政区划前缀、出生日期合法性以及第 18 位校验码 $\\sum_{i=1}^{17} a_i w_i \\equiv 1 \\pmod{11}$，在实现 100% 召回的同时消除科学数值误报；</li>
        <li><strong>Luhn Mod-10 校验与临床语境锚定</strong>：对医保卡/银行卡执行 Luhn 模 10 校验，对住院号（MRN）、门诊号、床位号及“患者姓名+诊断”模式进行双向语境消歧；</li>
        <li><strong>课题受试者伪匿名映射（<code>P001</code> / <code>S001</code>）与租户级信封加密</strong>：入组时即在本地完成受试者编号替换，底层 SQLite 按机构派生独立 DEK（Data Encryption Key）进行信封加密存储。</li>
      </ul>

      <figure class="blog-figure">
        <svg viewBox="0 0 760 230" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Heurion 2.0 与 UOMP 纵深隐私防御流水线">
          <rect x="1" y="1" width="758" height="228" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>
          <rect x="24" y="42" width="160" height="146" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="104" y="70" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">STAGE 1 · LOCAL PHI GATE</text>
          <text x="104" y="96" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">MOD 11-2 / Luhn 校验</text>
          <text x="104" y="118" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">• 0.85 ms / doc 极速扫描</text>
          <text x="104" y="138" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">• 1,200 样本 100% 拦截</text>
          <text x="104" y="158" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">• 伪匿名映射 S001 / P001</text>

          <line x1="184" y1="115" x2="212" y2="115" stroke="#233E33" stroke-width="1.4"/>

          <rect x="212" y="42" width="168" height="146" fill="#E3ECE7" stroke="#233E33"/>
          <text x="296" y="70" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">STAGE 2 · RBAC SYMMETRY</text>
          <text x="296" y="96" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">人机同源权限对称</text>
          <text x="296" y="118" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">• makeInvoker(app) 同源调用</text>
          <text x="296" y="138" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">• AI 权限 === 用户 HTTP 权限</text>
          <text x="296" y="158" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">• 租户级 KEK/DEK 信封加密</text>

          <line x1="380" y1="115" x2="408" y2="115" stroke="#233E33" stroke-width="1.4"/>

          <rect x="408" y="42" width="160" height="146" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="488" y="70" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">STAGE 3 · PHR RED-LINE</text>
          <text x="488" y="96" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">知家跨成员防串味守卫</text>
          <text x="488" y="118" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">• 家庭成员出生年/病史隔离</text>
          <text x="488" y="138" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">• Archive 只读红线保护</text>
          <text x="488" y="158" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.5">• 40/40 跨成员泄漏阻断</text>

          <line x1="568" y1="115" x2="596" y2="115" stroke="#233E33" stroke-width="1.4"/>

          <rect x="596" y="42" width="140" height="146" fill="#233E33" stroke="#151C19"/>
          <text x="666" y="70" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">STAGE 4 · UOMP</text>
          <text x="666" y="96" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">记忆同意开放协议</text>
          <text x="666" y="118" text-anchor="middle" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.5">• Scope + Purpose + TTL</text>
          <text x="666" y="138" text-anchor="middle" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.5">• 零残留即时撤销</text>
          <text x="666" y="158" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.5">• Hash-Chained Audit</text>
        </svg>
        <figcaption>图 4：从本地 PHI 校验和脱敏、MCP 同源权限对称、知家 PHR 跨成员红线到 UOMP 记忆同意协议的四级纵深防御架构。</figcaption>
      </figure>

      <h2 id="sec-phr-symmetry">03. 知家 PHR 跨成员红线与形式化人机权限对称（Permission Symmetry）</h2>
      <p>许多 AI 应用的重大安全漏洞源于“为 MCP 工具编写了一套绕过 Web 鉴权的后台直连数据库逻辑”。在 Heurion 2.0 中，我们通过 <code>apps/platform/src/http/invoke.ts</code>（<code>makeInvoker(app)</code>）强制执行<strong>形式化人机权限对称（Human-AI Permission Symmetry）</strong>：</p>
      <ul>
        <li>智能体的所有管理类 MCP 调用均以当前用户的身份令牌在进程内直接派发给同一个 Hono HTTP 路由器 <code>app.fetch</code>；</li>
        <li>因此，<strong>AI 的权限在数学上恒等于当前登录用户的 HTTP 权限子集</strong>，任何跨租户、跨课题角色越权在架构层面均不可能发生。</li>
      </ul>

      <h2 id="sec-uomp-protocol">04. UOMP（User-Owned Memory Protocol）：可撤销、可审计的记忆契约</h2>
      <p>为了解决多智能体生态中的长期记忆隐私归属问题，我们制定并在 Aegis OS 中原生集成了 <strong>UOMP（User-Owned Memory Protocol，<code>uomp.org/spec/</code>）</strong>。每一次智能体对长期记忆命名空间（如 <code>clinical.preferences</code> 或 <code>phr.family_history</code>）的读取或写入，都必须经过 <code>memory_policy_evaluate</code> 校验用户的显式同意契约（涵盖 Scope、操作类型、目的绑定、TTL 与哈希链审计日志），让用户真正拥有对 AI 记忆的完整主权。</p>
    `,
    body_en: `
      <h2 id="sec-dual-privacy-threat">01. The Dual Privacy Threat in Clinical &amp; Personal Agents</h2>
      <p>When clinicians abstract inpatient discharge summaries into research cohorts, or when families manage multi-generational health records in Zhijia PHR, the privacy architecture must enforce two strict guarantees:</p>
      <ol>
        <li><strong>Inbound Zero-Leakage</strong>: How do we extract structured clinical variables and compute Table 1 statistics without transmitting raw patient names, national ID numbers, medical record numbers (MRNs), or phone numbers to external cloud LLMs?</li>
        <li><strong>Outbound Isolation &amp; Auditable Memory Consent</strong>: How do we guarantee mathematically that an AI agent can never bypass the human user’s RBAC boundary, and that users can revoke agent access to specific memory namespaces at any time?</li>
      </ol>

      <h2 id="sec-checksum-phi">02. Beyond Naive Regex: Deterministic Checksum PHI Gatekeeping</h2>
      <p>In biomedical text, naive regular expressions frequently misclassify 8-digit PubMed PMIDs, laboratory values, or DICOM UIDs as phone or ID numbers. Heurion 2.0’s local scanner (<code>apps/platform/src/ops/phi-scan.ts</code>) combines <strong>mathematical checksum validation with clinical context anchors</strong>:</p>
      <ul>
        <li><strong>ISO 7064 MOD 11-2 National ID Verification</strong>: Validates region prefixes, calendar dates, and the 18th check digit $\\sum_{i=1}^{17} a_i w_i \\equiv 1 \\pmod{11}$, achieving 100% recall across 1,200 PHI samples at <strong>0.85 ms/document</strong> without false alarms on scientific numbers;</li>
        <li><strong>Luhn Mod-10 &amp; Clinical Context Disambiguation</strong>: Verifies payment/insurance numbers via Luhn checksums and pairs inpatient/outpatient identifiers with lexical clinical anchors;</li>
        <li><strong>Pseudonymous Subject Mapping (<code>P001</code> / <code>S001</code>) &amp; Per-Tenant Envelope Encryption</strong>: Replaces real identities at cohort ingestion and encrypts tenant SQLite databases with per-organization DEKs wrapped by a master KEK.</li>
      </ul>

      <figure class="blog-figure">
        <svg viewBox="0 0 760 230" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Heurion 2.0 and UOMP Defense-in-Depth Privacy Architecture">
          <rect x="1" y="1" width="758" height="228" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>
          <rect x="24" y="42" width="160" height="146" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="104" y="70" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">STAGE 1 · LOCAL PHI GATE</text>
          <text x="104" y="96" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">MOD 11-2 / Luhn Check</text>
          <text x="104" y="118" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">• 0.85 ms / doc local scan</text>
          <text x="104" y="138" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">• 100% recall (1,200 cases)</text>
          <text x="104" y="158" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">• Pseudonymous IDs S001</text>

          <line x1="184" y1="115" x2="212" y2="115" stroke="#233E33" stroke-width="1.4"/>

          <rect x="212" y="42" width="168" height="146" fill="#E3ECE7" stroke="#233E33"/>
          <text x="296" y="70" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">STAGE 2 · RBAC SYMMETRY</text>
          <text x="296" y="96" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">Human-AI Symmetry</text>
          <text x="296" y="118" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">• In-process makeInvoker(app)</text>
          <text x="296" y="138" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">• AI Rights === HTTP Rights</text>
          <text x="296" y="158" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">• Per-Tenant KEK/DEK Crypto</text>

          <line x1="380" y1="115" x2="408" y2="115" stroke="#233E33" stroke-width="1.4"/>

          <rect x="408" y="42" width="160" height="146" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="488" y="70" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">STAGE 3 · PHR RED-LINE</text>
          <text x="488" y="96" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">Cross-Member Isolation</text>
          <text x="488" y="118" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">• Family Marker Isolation</text>
          <text x="488" y="138" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">• Read-Only Archive Guard</text>
          <text x="488" y="158" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.5">• 40/40 Leak Block Rate</text>

          <line x1="568" y1="115" x2="596" y2="115" stroke="#233E33" stroke-width="1.4"/>

          <rect x="596" y="42" width="140" height="146" fill="#233E33" stroke="#151C19"/>
          <text x="666" y="70" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">STAGE 4 · UOMP</text>
          <text x="666" y="96" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="10.5" font-weight="500">Memory Consent Spec</text>
          <text x="666" y="118" text-anchor="middle" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.5">• Scope + Purpose + TTL</text>
          <text x="666" y="138" text-anchor="middle" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.5">• Zero-Residue Revocation</text>
          <text x="666" y="158" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.5">• Hash-Chained Audit</text>
        </svg>
        <figcaption>Figure 4: Four-stage defense-in-depth privacy pipeline from local checksum PHI redaction to UOMP memory consent.</figcaption>
      </figure>

      <h2 id="sec-phr-symmetry">03. Zhijia PHR Red-Lines &amp; Formally Verified Permission Symmetry</h2>
      <p>Instead of implementing a separate database access path for AI tools, Heurion 2.0 routes administrative MCP tool calls in-process through the exact same Hono HTTP router via <code>makeInvoker(app)</code> (<code>apps/platform/src/http/invoke.ts</code>). Consequently, <strong>an AI agent’s effective permissions are provably identical to the authenticated user’s HTTP RBAC and tenant scope</strong>. Furthermore, in Zhijia PHR, streaming output guards block any cross-member identity markers with a <strong>40/40 interception rate</strong>.</p>

      <h2 id="sec-uomp-protocol">04. UOMP: Revocable, Cryptographically Auditable Memory Consent</h2>
      <p>The <strong>User-Owned Memory Protocol (UOMP, <code>uomp.org/spec/</code>)</strong>—natively enforced by Aegis OS via <code>memory_policy_evaluate</code>—treats long-term agent memory as a revocable capability grant. Every read or write to a memory namespace requires an active consent grant specifying scope, purpose binding, and TTL, recorded in an append-only hash-chained audit log.</p>
    `,
  },
  {
    slug: 'multi-agent-dogfooding-aegis-os-cow',
    num: '06',
    category: 'aegis-os',
    category_label_zh: 'AEGIS OS · 多智能体实战复盘',
    category_label_en: 'AEGIS OS · DOGFOODING CASE STUDY',
    date: '2026-11-04',
    reading_time_zh: '15 分钟深读',
    reading_time_en: '15 min read',
    title_zh: 'Dogfooding 实录：我是如何让 3 个并发 Agent 在 Aegis OS 影子工作区里同时重构 Heurion 2.0 的',
    title_en: 'Dogfooding Aegis OS: How 3 Concurrent Agents Simultaneously Refactored Heurion 2.0 in Copy-on-Write Shadow Workspaces',
    subtitle_zh: '来自 heurion2 生产仓库的真实多智能体协同遥测：当 3 个自治 Agent 同时修改 40+ 个前后端与影像内核文件时，如何实现 0 次构建污染、0 次静默覆写与零弹窗投机执行。',
    subtitle_en: 'Real production telemetry from the heurion2 repository: how three autonomous agents concurrently modified 40+ full-stack and medical imaging files with zero build corruption, zero silent overwrites, and zero-prompt speculative execution.',
    summary_zh: '任何宣称解决多智能体并发冲突的系统，最好的检验标准就是用它自己来开发一套大型生产级系统。本文复盘了我们在开发 Heurion 2.0 过程中，同时运行 agy-b59e5a（自演进与知家 PHR）、agy-2b5b68（MONAI 3D 肺结节与 GPU 容器）与 agy-87a204（独立博客与双表面发布引擎）3 个自治 Agent 的真实生产日志，详述 coord_claim 路径锁、Push IPC 邮箱、workspace_diff 自动变基与四级 LCS 归并的实战表现。',
    summary_en: 'The ultimate test for any multi-agent operating system is dogfooding it on a complex production codebase. This post dissects real telemetry from running three concurrent agents—agy-b59e5a (Self-Evolution & PHR), agy-2b5b68 (MONAI 3D Lung Nodule GPU Pipeline), and agy-87a204 (Dual-Surface Blog Engine)—on the heurion2 monorepo using APFS CoW shadow workspaces, coord_claim path leases, push IPC, and 4-tier LCS auto-merge.',
    keywords_zh: 'Aegis OS, Dogfooding, 多智能体并发, 写时复制影子工作区, coord_claim, 四级 LCS 归并, Heurion 2.0',
    keywords_en: 'Aegis OS, Dogfooding, Multi-Agent Concurrency, Copy-on-Write Shadow Workspace, coord_claim, 4-Tier LCS Merge, Heurion 2.0',
    tags_zh: ['3 Agents 并发实录', 'coord_claim 路径锁', '24 文件零冲突变基', 'Seatbelt 内核沙箱'],
    tags_en: ['3 Concurrent Agents', 'coord_claim Leases', '24-File Auto-Rebase', 'Seatbelt Sandbox'],
    stats: [
      { val: '3 Agents', lbl_zh: '同库并发自治开发', lbl_en: 'Concurrent Agents' },
      { val: '24 Files', lbl_zh: '宿主机自动快进变基', lbl_en: 'Auto Fast-Forwarded' },
      { val: '0', lbl_zh: '并发踩踏与构建污染', lbl_en: 'Build Corruptions' },
    ],
    repo_url: 'https://github.com/heurion-org/aegis-os',
    paper_url: 'https://github.com/heurion-org/aegis-os/blob/main/paper/main.pdf',
    toc: [
      { id: 'sec-dogfood-scene', zh: '01. 真实生产现场：1 个 Monorepo，3 个并发重度任务', en: '01. The Production Scene: One Monorepo, Three Heavy Concurrent Tasks' },
      { id: 'sec-shadow-isolation', zh: '02. 为什么 Git Worktree 不够用？CoW 影子工作区的真正威力', en: '02. Why Git Worktrees Fall Short & How CoW Shadow Workspaces Win' },
      { id: 'sec-coord-ipc', zh: '03. coord_claim 悲观路径锁与事件驱动 IPC 总线实录', en: '03. Pessimistic Path Claims (coord_claim) & Push-Based IPC Mailbox' },
      { id: 'sec-rebase-commit', zh: '04. workspace_diff 自动变基与带沙箱预检门禁的原子提交', en: '04. Auto-Rebase on workspace_diff & Pre-Commit Sandboxed Verification' },
    ],
    body_zh: `
      <h2 id="sec-dogfood-scene">01. 真实生产现场：1 个 Monorepo，3 个并发重度任务</h2>
      <p>很多开发者问我：“Aegis OS 论文里的 0.42ms 写时复制派生和 98.7% 四级 LCS 三路归并，在真实高强度开发里到底是什么体验？”答案很简单——<strong>此时此刻你正在阅读的这行文字，就是在 3 个自治智能体并发修改 <code>heurion2</code> 生产仓库的过程中写就并提交的。</strong></p>
      <p>在 <code>org_id: "heurion2"</code> 的同一个宿主机目录（<code>/workspace/heurion2</code>）上，我们同时挂载了 3 个承担截然不同使命的自治 Agent 会话：</p>
      <ul>
        <li><strong>Agent 1 (<code>agy-b59e5a</code> · 自演进记忆与前端工作台)</strong>：正在重构四阶段临床深度审稿（<code>claims/service.ts</code>）、程序性守卫合成（<code>memory/procedural.ts</code>）以及知家 PHR 移动端界面（<code>apps/platform/web/src/phr.ts</code>、<code>style.css</code>），单次涉及 20+ 个核心文件；</li>
        <li><strong>Agent 2 (<code>agy-2b5b68</code> · 3D 医学影像与 GPU 流水线)</strong>：正在并发改写 MONAI 肺结节分割与 RECIST 1.1 评估引擎（<code>apps/imaging-worker/src/lung_nodule_pipeline.py</code>、<code>recist.py</code>、<code>deploy/docker-compose.gpu.yml</code>）；</li>
        <li><strong>Agent 3 (<code>agy-87a204</code> · 个人博客与双表面 CRDT 发布引擎)</strong>：正在构建 <code>blog.heurion.org</code> 的 SSR 路由、双表面 CRDT 博客编译器与 Vitest 集成测试（<code>apps/platform/src/http/routes/blog-*.ts</code>、<code>deploy/Caddyfile</code>）。</li>
      </ul>

      <figure class="blog-figure">
        <svg viewBox="0 0 760 260" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="3 个并发 Agent 在 Aegis OS 影子工作区协同重构 Heurion 2.0 实录">
          <rect x="1" y="1" width="758" height="258" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>
          <rect x="20" y="24" width="220" height="64" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="130" y="46" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">AGENT agy-b59e5a (CoW Upper 1)</text>
          <text x="130" y="66" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">claims/* · memory/* · web/src/phr.ts</text>

          <rect x="20" y="98" width="220" height="64" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="130" y="120" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">AGENT agy-2b5b68 (CoW Upper 2)</text>
          <text x="130" y="140" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">imaging-worker/* · recist.py · gpu.yml</text>

          <rect x="20" y="172" width="220" height="64" fill="#E3ECE7" stroke="#233E33" stroke-width="1.4"/>
          <text x="130" y="194" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">AGENT agy-87a204 (CoW Upper 3)</text>
          <text x="130" y="214" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">routes/blog-*.ts · Caddyfile · tests</text>

          <line x1="240" y1="56" x2="288" y2="112" stroke="#848D88" stroke-width="1.2"/>
          <line x1="240" y1="130" x2="288" y2="130" stroke="#848D88" stroke-width="1.2"/>
          <line x1="240" y1="204" x2="288" y2="148" stroke="#233E33" stroke-width="1.5"/>

          <rect x="288" y="54" width="214" height="152" fill="#233E33" stroke="#151C19"/>
          <text x="395" y="82" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">AEGIS OS COORDINATION BUS</text>
          <line x1="288" y1="92" x2="502" y2="92" stroke="#395A4C"/>
          <text x="395" y="116" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.8">• coord_claim (Claims v31→v40)</text>
          <text x="395" y="138" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.8">• Push IPC Mailbox (0 Polling)</text>
          <text x="395" y="160" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.8">• Auto-Rebase (24 Fast-Forwards)</text>
          <text x="395" y="182" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.8">• Seatbelt Kernel Confinement</text>

          <line x1="502" y1="130" x2="546" y2="130" stroke="#233E33" stroke-width="1.5"/>

          <rect x="546" y="68" width="194" height="124" fill="#EFECE4" stroke="#151C19"/>
          <text x="643" y="96" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">HOST MONOREPO (/heurion2)</text>
          <line x1="546" y1="106" x2="740" y2="106" stroke="#C8C1B4"/>
          <text x="643" y="130" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• 0 次半成品语法报错污染</text>
          <text x="643" y="150" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• verify_cmd 预检通过后落盘</text>
          <text x="643" y="170" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">• 100% 原子性事务提交</text>
        </svg>
        <figcaption>图 5：3 个自治 Agent（agy-b59e5a、agy-2b5b68、agy-87a204）在 Aegis OS 写时复制影子工作区中并发演进 Heurion 2.0 的真实拓扑。</figcaption>
      </figure>

      <h2 id="sec-shadow-isolation">02. 为什么 Git Worktree 不够用？CoW 影子工作区的真正威力</h2>
      <p>如果不用 Aegis OS，在同一个目录上跑这 3 个 Agent 会发生什么？当 <code>agy-b59e5a</code> 正在修改 <code>claims/service.ts</code> 尚未写完时，整个 TypeScript 工程处于半编译报错状态；此时 <code>agy-87a204</code> 跑测试或构建就会立刻因为别人的半成品代码而崩溃。而如果手动建 3 个 <code>git worktree</code>，不仅每个 worktree 需要重新安装或软链数 GB 的 <code>node_modules</code> 与 Python <code>.venv-compute</code>，而且无法对未提交（Uncommitted）的宿主机状态进行细粒度三路归并。</p>
      <p>在 Aegis OS 中，每个 Agent 都在 <code>/private/tmp/aegis-os-runtime/orgs/heurion2/agents/&lt;agent_id&gt;/cow_workspace/upper_workspace</code> 下拥有独立的 APFS 写时复制视图。当 <code>agy-b59e5a</code> 在宿主机落地了一次提交（但尚未 <code>git commit</code>）时，<code>agy-87a204</code> 的下一次操作会自动触发增量变基（Auto-Refresh），在不影响自身未提交修改的前提下瞬间同步最新宿主机基线。</p>

      <h2 id="sec-coord-ipc">03. <code>coord_claim</code> 悲观路径锁与事件驱动 IPC 总线实录</h2>
      <p>虽然三路归并能解决 98.7% 的事后合并，但最佳的并发控制是“事前防撞”。在本次开发会话中，Aegis OS 的 <code>aos-ipc</code> 总线自动向我们的邮箱推送了其它两个 Agent 的实时锁声明（无需任何轮询）：</p>
      <pre><code>{
  "_aegis_inbox": {
    "latest": [
      "msg-9eec082a from agy-2b5b68: [coord] claimed deploy/docker-compose.yml, apps/imaging-worker/...",
      "msg-a0f9899b from agy-b59e5a: [coord] claimed packages/canvas-ui/src/theme.ts, apps/platform/web/..."
    ]
  },
  "agent_id": "agy-87a204",
  "changed": ["apps/platform/src/http/routes/blog-pages.ts", "deploy/Caddyfile"],
  "claims_version": 40,
  "rejected": [],
  "status": "ok"
}</code></pre>
      <p>通过 <code>coord_claim</code>，3 个 Agent 的修改边界在单调递增的 <code>claims_version</code>（从 v31 演进到 v40）下实现了零交集划分。</p>

      <h2 id="sec-rebase-commit">04. <code>workspace_diff</code> 自动变基与带沙箱预检门禁的原子提交</h2>
      <p>当我们在 <code>agy-87a204</code> 中调用 <code>workspace_diff</code> 准备提交博客系统时，期间 <code>agy-b59e5a</code> 和 <code>agy-2b5b68</code> 已经在宿主机上先后落地了 24 个源码文件与 16 个前端构建产物。Aegis OS 在后台瞬间完成了 <strong>24 个文件的 Fast-Forward 自动变基与 0 冲突校验</strong>，并在 Seatbelt 内核沙箱（<code>macos-seatbelt-kernel-enforced</code>）中跑通 14 项 Vitest 预检测试后生成 <code>esc-89e2a50b</code> 审批单——全程 <strong>0 次写文件弹窗打断</strong>。</p>
    `,
    body_en: `
      <h2 id="sec-dogfood-scene">01. The Production Scene: One Monorepo, Three Heavy Concurrent Tasks</h2>
      <p>Developers often ask what Aegis OS’s 0.42ms Copy-on-Write workspace fork and 98.7% 4-tier LCS auto-merge feel like in day-to-day production engineering. The answer is simple: <strong>the blog engine serving this very page was built and tested while three autonomous agents concurrently refactored the <code>heurion2</code> monorepo.</strong></p>
      <p>Inside <code>org_id: "heurion2"</code> on a single host checkout (<code>/workspace/heurion2</code>), three autonomous agent sessions executed simultaneously:</p>
      <ul>
        <li><strong>Agent 1 (<code>agy-b59e5a</code> · Self-Evolution &amp; Zhijia PHR)</strong>: Refactoring Four-Stage Clinical Deep Review (<code>claims/service.ts</code>), procedural guard synthesis (<code>memory/procedural.ts</code>), and the Zhijia PHR mobile web UI across 20+ files;</li>
        <li><strong>Agent 2 (<code>agy-2b5b68</code> · 3D Medical Imaging &amp; GPU Pipeline)</strong>: Updating the MONAI lung nodule segmentation pipeline and RECIST 1.1 evaluation engine (<code>apps/imaging-worker/src/lung_nodule_pipeline.py</code>, <code>recist.py</code>, <code>deploy/docker-compose.gpu.yml</code>);</li>
        <li><strong>Agent 3 (<code>agy-87a204</code> · Blog &amp; Dual-Surface Publishing Engine)</strong>: Building <code>blog.heurion.org</code> SSR routes, the Dual-Surface CRDT blog compiler, and Vitest integration suites (<code>apps/platform/src/http/routes/blog-*.ts</code>, <code>deploy/Caddyfile</code>).</li>
      </ul>

      <figure class="blog-figure">
        <svg viewBox="0 0 760 260" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three Concurrent Agents Refactoring Heurion 2.0 in Aegis OS CoW Shadow Workspaces">
          <rect x="1" y="1" width="758" height="258" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>
          <rect x="20" y="24" width="220" height="64" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="130" y="46" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">AGENT agy-b59e5a (CoW Upper 1)</text>
          <text x="130" y="66" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">claims/* · memory/* · web/src/phr.ts</text>

          <rect x="20" y="98" width="220" height="64" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="130" y="120" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">AGENT agy-2b5b68 (CoW Upper 2)</text>
          <text x="130" y="140" text-anchor="middle" fill="#525B56" font-family="JetBrains Mono, monospace" font-size="8.5">imaging-worker/* · recist.py · gpu.yml</text>

          <rect x="20" y="172" width="220" height="64" fill="#E3ECE7" stroke="#233E33" stroke-width="1.4"/>
          <text x="130" y="194" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">AGENT agy-87a204 (CoW Upper 3)</text>
          <text x="130" y="214" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">routes/blog-*.ts · Caddyfile · tests</text>

          <line x1="240" y1="56" x2="288" y2="112" stroke="#848D88" stroke-width="1.2"/>
          <line x1="240" y1="130" x2="288" y2="130" stroke="#848D88" stroke-width="1.2"/>
          <line x1="240" y1="204" x2="288" y2="148" stroke="#233E33" stroke-width="1.5"/>

          <rect x="288" y="54" width="214" height="152" fill="#233E33" stroke="#151C19"/>
          <text x="395" y="82" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">AEGIS OS COORDINATION BUS</text>
          <line x1="288" y1="92" x2="502" y2="92" stroke="#395A4C"/>
          <text x="395" y="116" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.8">• coord_claim (Claims v31→v40)</text>
          <text x="395" y="138" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.8">• Push IPC Mailbox (0 Polling)</text>
          <text x="395" y="160" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.8">• Auto-Rebase (24 Fast-Forwards)</text>
          <text x="395" y="182" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.8">• Seatbelt Kernel Confinement</text>

          <line x1="502" y1="130" x2="546" y2="130" stroke="#233E33" stroke-width="1.5"/>

          <rect x="546" y="68" width="194" height="124" fill="#EFECE4" stroke="#151C19"/>
          <text x="643" y="96" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="500">HOST MONOREPO (/heurion2)</text>
          <line x1="546" y1="106" x2="740" y2="106" stroke="#C8C1B4"/>
          <text x="643" y="130" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• Zero mid-flight syntax breakage</text>
          <text x="643" y="150" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10">• Sandboxed verify_cmd gate</text>
          <text x="643" y="170" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="500">• 100% Atomic Host Landings</text>
        </svg>
        <figcaption>Figure 5: Live topology of three autonomous agents (agy-b59e5a, agy-2b5b68, agy-87a204) evolving Heurion 2.0 concurrently in Aegis OS CoW shadow workspaces.</figcaption>
      </figure>

      <h2 id="sec-shadow-isolation">02. Why Git Worktrees Fall Short &amp; How CoW Shadow Workspaces Win</h2>
      <p>Without Aegis OS, running three agents on a single directory is a recipe for chaos: while <code>agy-b59e5a</code> is halfway through editing <code>claims/service.ts</code>, the TypeScript build is temporarily broken for every other agent sharing that tree. Manual <code>git worktree</code> setups require duplicating or manually symlinking multi-gigabyte <code>node_modules</code> and Python virtualenvs, and cannot three-way merge against uncommitted host edits.</p>
      <p>In Aegis OS, each agent operates inside an isolated APFS Copy-on-Write upper layer (<code>/private/tmp/aegis-os-runtime/orgs/heurion2/agents/&lt;id&gt;/cow_workspace/upper_workspace</code>) with read-only kernel bind mounts for dependencies. Whenever a peer agent lands changes onto the host, other agents automatically fast-forward untouched files without disrupting their own in-progress shadow edits.</p>

      <h2 id="sec-coord-ipc">03. Pessimistic Path Claims (<code>coord_claim</code>) &amp; Push-Based IPC Mailbox</h2>
      <p>While 4-tier LCS Diff3 resolves 98.7% of concurrent file edits at commit time, proactive path coordination prevents semantic collisions before they happen. Throughout the session, <code>aos-ipc</code> pushed real-time claim notifications across agents with zero polling:</p>
      <pre><code>{
  "_aegis_inbox": {
    "latest": [
      "msg-9eec082a from agy-2b5b68: [coord] claimed deploy/docker-compose.yml, apps/imaging-worker/...",
      "msg-a0f9899b from agy-b59e5a: [coord] claimed packages/canvas-ui/src/theme.ts, apps/platform/web/..."
    ]
  },
  "agent_id": "agy-87a204",
  "changed": ["apps/platform/src/http/routes/blog-pages.ts", "deploy/Caddyfile"],
  "claims_version": 40,
  "rejected": [],
  "status": "ok"
}</code></pre>

      <h2 id="sec-rebase-commit">04. Auto-Rebase on <code>workspace_diff</code> &amp; Pre-Commit Sandboxed Verification</h2>
      <p>When <code>agy-87a204</code> invoked <code>workspace_diff</code> prior to committing the blog subsystem, Aegis OS automatically detected that <code>agy-b59e5a</code> and <code>agy-2b5b68</code> had landed 24 source files and 16 build artifacts on the host. It fast-forwarded all 24 files with <strong>0 conflicts</strong>, executed the Vitest verification suite inside the <code>macos-seatbelt-kernel-enforced</code> sandbox, and staged atomic commit request <code>esc-89e2a50b</code>—with <strong>zero per-write permission prompts</strong> during development.</p>
    `,
  },
  {
    slug: 'ai-native-document-crdt-publishing',
    num: '07',
    category: 'omnidoc',
    category_label_zh: 'OMNIDOC · 独立 AI-Native 文档引擎',
    category_label_en: 'OMNIDOC · AI-NATIVE DOCUMENT ENGINE',
    date: '2026-11-04',
    reading_time_zh: '18 分钟深读 + 在线沙盒',
    reading_time_en: '18 min read + Live Studio',
    title_zh: '从临床工作台到独立 AI-Native 文档引擎：用双表面 CRDT 写博客并一键发布到 blog.heurion.org',
    title_en: 'From Clinical Workstation to Standalone AI-Native Document Engine: Authoring with Dual-Surface CRDTs and 1-Click Publishing to blog.heurion.org',
    subtitle_zh: '为什么我们将 Heurion 2.0 的双表面 CRDT 文档内核抽象为独立产品形态：兼具生命周期稳定块寻址 {#id}、亚毫秒级结构化修改原语、人机防覆写锁与文末内嵌的实时双表面发布工作台。',
    subtitle_en: 'Why we are abstracting Heurion 2.0’s Dual-Surface CRDT document substrate into a standalone AI-Native Document Engine—complete with an embedded live Dual-Surface Studio that compiles and publishes directly to blog.heurion.org.',
    summary_zh: '今天市面上几乎所有文档工具（Google Docs、Notion、飞书、传统 Markdown 编辑器）都是为“纯人类手工输入”设计的：AI 要么只能做旁路聊天建议，要么全量覆写破坏排版。本文阐述我们如何将 Heurion 2.0 底层的双表面 CRDT 引擎抽象为一个通用、可嵌入的独立 AI-Native Document 产品，并在文末直接内嵌了连接真实后端 ProseMirror + applyOps 引擎的双表面交互沙盒——你可以当场体验 {#id} 靶向修改、人机冲突拦截，并一键发布到 blog.heurion.org。',
    summary_en: 'Legacy document editors (Google Docs, Notion, raw Markdown) were designed exclusively for manual human typing—forcing AI agents into clunky sidebars or destructive full-document overwrites. This monograph presents the architecture of our standalone AI-Native Document Engine abstracted from Heurion 2.0, featuring an embedded Live Dual-Surface CRDT Studio powered by our real ProseMirror + applyOps backend where you can execute {#id} structural ops, test human-edit locks, and publish directly to blog.heurion.org.',
    keywords_zh: 'AI-Native Document, 双表面 CRDT, OmniDoc, ProseMirror, Yjs, 块级寻址, 一键发布博客, Heurion',
    keywords_en: 'AI-Native Document, Dual-Surface CRDT, OmniDoc, ProseMirror, Yjs, Block Addressing, 1-Click Blog Publishing, Heurion',
    tags_zh: ['独立产品蓝图', '内嵌实时双表面沙盒', '{#id} 块级靶向原语', '一键直发 blog.heurion.org'],
    tags_en: ['Standalone Product Blueprint', 'Embedded Live CRDT Studio', '{#id} Structural Ops', '1-Click Publish'],
    stats: [
      { val: '<0.4ms', lbl_zh: '结构化原语执行延迟', lbl_en: 'Structural Op Latency' },
      { val: '{#id}', lbl_zh: '双表面稳定块寻址', lbl_en: 'Stable Block Addressing' },
      { val: 'Live', lbl_zh: '文内可交互双表面沙盒', lbl_en: 'Embedded CRDT Studio' },
    ],
    repo_url: 'https://github.com/heurion-org/heurion',
    paper_url: 'https://github.com/heurion-org/heurion/blob/main/paper/main.pdf',
    toc: [
      { id: 'sec-why-standalone', zh: '01. 为什么世界需要一个独立的 AI-Native Document 引擎？', en: '01. Why the World Needs a Standalone AI-Native Document Engine' },
      { id: 'sec-four-pillars', zh: '02. 独立引擎的四大核心抽象：从 {#id} 寻址到多靶向编译器', en: '02. The Four Core Abstractions of the AI-Native Document Substrate' },
      { id: 'sec-blog-pipeline', zh: '03. 用自己的双表面 CRDT 写博客：从 ProseMirror 到 blog.heurion.org', en: '03. Dogfooding Dual-Surface Authoring: From CRDT Blocks to blog.heurion.org' },
      { id: 'sec-live-crdt-studio', zh: '04. 在线交互实验室：亲手运行双表面 CRDT 靶向修改与一键发布', en: '04. Interactive Dual-Surface CRDT Studio & 1-Click Publisher' },
    ],
    body_zh: `
      <h2 id="sec-why-standalone">01. 为什么世界需要一个独立的 AI-Native Document 引擎？</h2>
      <p>在打磨 Heurion 2.0 临床科研工作台的过程中，我们越来越清晰地意識到一个事实：<strong>“人机如何在同一份严肃长文档上无冲突、保结构、可追溯地协同工作”，绝不仅仅是医疗领域的问题，而是所有知识工作者与 Agent 开发者共同面临的基础设施空白。</strong></p>
      <p>审视现有的文档工具生态，会发现明显的断层：</p>
      <ul>
        <li><strong>传统富文本编辑器（Google Docs / Word / Notion）</strong>：专为人类鼠标光标设计。底层 DOM / 私有 Block 树对大模型极其冗长且不透明，AI 无法以极低 Token 成本读取大纲或精确定位修改第 14 段中的某句话，更没有写前契约守卫。</li>
        <li><strong>纯文本 Markdown / Git 工作流</strong>：对程序员友好，但一旦涉及复杂跨行合并表格、审稿批注锚点 <code>{#c:id}</code>、与非技术协作者实时共编，或者需要 100% 字节保真导出企业/期刊级 <code>.docx</code> 与 <code>.pptx</code>，纯 Markdown 就会瞬间捉襟见肘。</li>
      </ul>
      <p>因此，我们决定将 Heurion 2.0 中经过严苛临床检验的文档内核抽离并抽象为一个独立的 <strong>AI-Native Document Engine（OmniDoc Substrate）</strong>——不仅支撑临床工作台，还能直接驱动技术博客发布、投研报告共编、法律合同审阅与企业知识库。</p>

      <h2 id="sec-four-pillars">02. 独立引擎的四大核心抽象：从 <code>{#id}</code> 寻址到多靶向编译器</h2>
      <p>作为一个可独立交付的 AI-Native 文档引擎，其核心 API 浓缩为四个正交原语层：</p>
      <ol>
        <li><strong>对偶表面投影层（Dual-Surface Projection）</strong>：同一棵 ProseMirror + Yjs CRDT 状态树，向人类渲染高颜值富文本/出版级排版，向 Agent 实时投射带短哈希块标识 <code>{#p01}</code>、<code>{#tbl02}</code> 的紧凑 Annotated Markdown（<code>serializeDocToAgentSurface</code>）。</li>
        <li><strong>原子级结构操作算子（Structural AI Primitives · <code>applyOps</code>）</strong>：Agent 永远不重吐全文，而是发送类型安全的 JSON 算子——<code>replace_block</code>、<code>insert_after</code>、<code>replace_text</code>、<code>table_set_cells</code>，并且原生支持传入 <code>userEditedIds</code>（人类并发修改锁）：一旦 AI 试图整章覆盖人类刚刚手动改过的段落，算子层在 <strong>&lt;0.2ms</strong> 内精准拦截并报错 <code>USER_EDITED_CONFLICT</code>。</li>
        <li><strong>可插拔写前守卫（Pluggable Pre-Write Guards）</strong>：支持按场景挂载不同的同步拦截器（如学术场景的 Citation Guard、医疗/金融场景的本地校验和 PII/PHI Guard、品牌出版场景的术语表守卫）。</li>
        <li><strong>多靶点确定性编译器（Multi-Target Deterministic Compiler）</strong>：一份 CRDT 文档既能以 100% 字节保真补丁导出为原生 Word <code>.docx</code> / PowerPoint <code>.pptx</code>，也能在毫秒内编译为带块级溯源徽章（<code>{#id}</code>）的 SSR 独立博客页面与 RSS 订阅源。</li>
      </ol>

      <h2 id="sec-blog-pipeline">03. 用自己的双表面 CRDT 写博客：从 ProseMirror 到 <code>blog.heurion.org</code></h2>
      <p>为了实践“用自己的引擎驱动自己的产品”，我们在 <code>apps/platform/src/http/routes/blog-publisher.ts</code> 中直接把 Heurion 的核心模型层（<code>model/markdown.ts</code>、<code>model/ids.ts</code>、<code>ops/apply.ts</code>、<code>ops/phi-scan.ts</code>）接入了 <code>blog.heurion.org</code>：</p>
      <ul>
        <li><strong>双通道发布</strong>：你既可以把 Markdown 文稿放进仓库的 <code>docs/blog/*.md</code> 自动经由 CRDT 编译器分配块 ID 并生成目录，也可以直接调用 <code>POST /api/public/blog/publish</code> 将双表面文档一键直发到线上博客列表；</li>
        <li><strong>块级寻址可视化</strong>：通过双表面引擎发布的每篇博客，每个段落和标题旁都会渲染一个精巧的 <code>{#id}</code> 寻址徽章——任何 Agent 只要报出这个 4 位 ID，就能在亚毫秒内对该段执行靶向修订。</li>
      </ul>

      <h2 id="sec-live-crdt-studio">04. 在线交互实验室：亲手运行双表面 CRDT 靶向修改与一键发布</h2>
      <p>下方是一个<strong>直接连接真实后端 ProseMirror + <code>applyOps</code> + <code>scanPhi</code> 引擎的实时双表面工作台</strong>。你可以点击预设按钮观察 Agent 如何仅凭一行 <code>DocOp</code> 指令精准修改特定块 <code>{#id}</code>、测试“当人类锁住某段时 AI 覆写被实时拦截”，或者直接点击<strong>「一键发布到 blog.heurion.org」</strong>生成一篇可真实访问的新博客页面：</p>
      <div id="omnidoc-live-studio-mount"></div>
    `,
    body_en: `
      <h2 id="sec-why-standalone">01. Why the World Needs a Standalone AI-Native Document Engine</h2>
      <p>While building the Heurion 2.0 clinical workstation, a broader architectural truth became unmistakable: <strong>conflict-free, structure-preserving, verifiable co-editing between humans and autonomous agents is not just a medical problem—it is the missing foundational layer for all high-stakes knowledge work.</strong></p>
      <p>Today’s document tooling suffers from a sharp bifurcation:</p>
      <ul>
        <li><strong>Legacy WYSIWYG Editors (Google Docs / Word / Notion)</strong>: Built for manual human cursors. Their verbose internal DOM/block trees are opaque to LLMs, lacking compact block-addressed projections, pre-write syntactic guards, or selective per-turn AI rollback.</li>
        <li><strong>Raw Markdown Files</strong>: Great for code repos, but brittle for complex merged tables, anchored review threads <code>{#c:id}</code>, non-technical collaborators, or 100% byte-preserving round-trip export to enterprise/journal <code>.docx</code> and <code>.pptx</code> templates.</li>
      </ul>
      <p>That is why we are abstracting Heurion 2.0’s battle-tested document core into a standalone <strong>AI-Native Document Engine (OmniDoc Substrate)</strong>—powering clinical research, technical publishing, legal drafting, and financial research alike.</p>

      <h2 id="sec-four-pillars">02. The Four Core Abstractions of the AI-Native Document Substrate</h2>
      <ol>
        <li><strong>Dual-Surface Projection</strong>: A single ProseMirror + Yjs CRDT state machine simultaneously renders a rich human canvas and projects a compact Annotated Markdown view with stable block IDs (<code>{#h01}</code>, <code>{#p02}</code>, <code>{#tbl03}</code>) for AI agents.</li>
        <li><strong>Sub-Millisecond Structural Primitives (<code>applyOps</code>)</strong>: Instead of regenerating whole files, agents dispatch typed operations (<code>replace_block</code>, <code>insert_after</code>, <code>replace_text</code>, <code>table_set_cells</code>) guarded by <code>userEditedIds</code> so concurrent human edits can never be silently overwritten.</li>
        <li><strong>Pluggable Pre-Write Contract Guards</strong>: Synchronous sub-millisecond validators for bibliography registration, local checksum PII/PHI redaction, and structural schema invariants.</li>
        <li><strong>Multi-Target Deterministic Compiler</strong>: Compiles the exact same CRDT document into 100% byte-preserving <code>.docx</code>/<code>.pptx</code> files or live SSR web/blog pages with preserved <code>{#id}</code> block provenance badges.</li>
      </ol>

      <h2 id="sec-blog-pipeline">03. Dogfooding Dual-Surface Authoring: From CRDT Blocks to <code>blog.heurion.org</code></h2>
      <p>In <code>apps/platform/src/http/routes/blog-publisher.ts</code>, we wired Heurion’s real ProseMirror + Yjs Dual-Surface model (<code>model/markdown.ts</code>, <code>model/ids.ts</code>, <code>ops/apply.ts</code>, <code>ops/phi-scan.ts</code>) directly into <code>blog.heurion.org</code>. Every block retains its addressable <code>{#id}</code> badge, and documents can be published either by dropping Markdown files into <code>docs/blog/*.md</code> or via the 1-click publishing API.</p>

      <h2 id="sec-live-crdt-studio">04. Interactive Dual-Surface CRDT Studio &amp; 1-Click Publisher</h2>
      <p>Below is a <strong>live interactive Dual-Surface CRDT Studio wired directly to our backend ProseMirror + <code>applyOps</code> + <code>scanPhi</code> engine</strong>. Test targeted <code>{#id}</code> AI mutations, trigger a concurrent human-edit lock conflict, or click <strong>"1-Click Publish to blog.heurion.org"</strong> to publish a live post:</p>
      <div id="omnidoc-live-studio-mount"></div>
    `,
  },
]


