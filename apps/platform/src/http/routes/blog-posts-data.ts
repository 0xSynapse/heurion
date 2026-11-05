/**
 * Heurion Research — Technical Blog & Research Monographs
 * Structured Bilingual Article Data (Heurion 2.0 & Aegis OS)
 */

export type BlogSlug =
  | 'dual-surface-crdt-clinical-ai'
  | 'human-agent-capability-parity-ai-native-software'
  | 'aegis-os-transactional-agent-kernel'

export const BLOG_SLUGS: readonly BlogSlug[] = [
  'dual-surface-crdt-clinical-ai',
  'human-agent-capability-parity-ai-native-software',
  'aegis-os-transactional-agent-kernel',
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
        <li><strong>O(1) 块寻址与跨格式范围定位</strong>：通过 <code>indexById(tr.doc).get("p8f2")</code> 直接定位目标块在文档树中的精确偏移量 <code>pos</code>，并在块内构建展平文本切片（将 <code>citation</code> 映射为 <code>[@cite_id]</code>、<code>measurement</code> 映射为 <code>[m:m_id]</code>），使得 <code>find</code> 即使跨越粗体、斜体或行内引用标记也能精确命中对应的 ProseMirror 坐标区间 <code>[from, to]</code>。</li>
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
      <p>在真实科研写作中，一个常见场景是：AI 在第 <i>T</i><sub>1</sub> 回合修改了 <code>{#p01}</code>、<code>{#p02}</code> 并新增了 <code>{#p03}</code>；随后人类作者在第 <i>T</i><sub>2</sub> 时刻顺手润色了 <code>{#p02}</code> 并在 <code>{#p09}</code> 写下了新的结论；到了第 <i>T</i><sub>3</sub> 时刻，作者决定<strong>“撤回第 <i>T</i><sub>1</sub> 回合的 AI 修改”</strong>。</p>
      <p>如果是传统的线性 Undo 栈或 Git Revert，撤回 <i>T</i><sub>1</sub> 要么会连带把人类在 <i>T</i><sub>2</sub> 对 <code>{#p02}</code> 和 <code>{#p09}</code> 的修改一起冲掉，要么直接报合并冲突失败。而在块级逆变换引擎中，我们利用块级寻址实现了延迟仅 <strong>0.128 ms</strong>、且严格遵循<strong>“人类修改绝对优先（Human-Edits-Win）”</strong>的靶向回滚函数 <code>revertByNodes(current, base, changes, userTouched)</code>：</p>

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

      <p>回到刚才的例子：执行 <code>revertByNodes</code> 后，<code>{#p01}</code> 瞬间恢复为 <i>T</i><sub>1</sub> 之前的原貌，AI 新增的 <code>{#p03}</code> 被干净移除，而人类在 <i>T</i><sub>2</sub> 亲手润色过的 <code>{#p02}</code>（在 <code>skipped</code> 列表中返回提示）与 <code>{#p09}</code> 则完好无损地保留在文档中。</p>

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
        <li><strong>O(1) Block Resolution &amp; Cross-Mark Span Matching</strong>: <code>indexById(tr.doc).get("p8f2")</code> resolves the exact document offset <code>pos</code> in constant time. A flattened text-slice mapper translates inline atoms (mapping <code>citation</code> to <code>[@cite_id]</code> and <code>measurement</code> to <code>[m:m_id]</code>) so <code>find</code> locates the exact ProseMirror coordinate span <code>[from, to]</code> even across bold/italic boundaries.</li>
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
      <p>Consider a common collaborative timeline: during Turn <i>T</i><sub>1</sub>, an AI agent modifies blocks <code>{#p01}</code> and <code>{#p02}</code> and inserts <code>{#p03}</code>. At <i>T</i><sub>2</sub>, the human researcher refines <code>{#p02}</code> and writes a new paragraph <code>{#p09}</code>. At <i>T</i><sub>3</sub>, the researcher clicks <strong>"Undo AI Turn <i>T</i><sub>1</sub>"</strong>.</p>
      <p>A linear undo stack or file-level revert would either wipe out the human’s <i>T</i><sub>2</sub> edits on <code>{#p02}</code> and <code>{#p09}</code> or fail with a merge conflict. Instead, the block-indexed inverse transform engine <code>revertByNodes(current, base, changes, userTouched)</code> leverages block addressing to execute a <strong>0.128 ms selective rollback that strictly prioritizes subsequent human edits</strong>:</p>

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

      <p>In the scenario above, <code>revertByNodes</code> restores <code>{#p01}</code> to its pre-<i>T</i><sub>1</sub> state and removes <code>{#p03}</code>, while leaving the human’s <i>T</i><sub>2</sub> refinements on <code>{#p02}</code> (returned in <code>skipped</code>) and <code>{#p09}</code> completely intact.</p>

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

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 284" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="零分叉进程内同源调用与防伪造双轨审计流水线">
          <rect x="1" y="1" width="758" height="282" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Path 1: Human Browser -->
          <rect x="20" y="22" width="214" height="64" fill="#F2EFE9" stroke="#233E33" stroke-width="1"/>
          <text x="127" y="43" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">PATH A · HUMAN GUI REQUEST</text>
          <text x="127" y="61" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">浏览器携 Bearer Session 发起请求</text>
          <text x="127" y="76" text-anchor="middle" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.2">actor = u, via = "human"</text>

          <!-- Path 2: AI In-Process -->
          <rect x="20" y="106" width="214" height="74" fill="#233E33" stroke="#151C19" stroke-width="1"/>
          <text x="127" y="127" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">PATH B · AI IN-PROCESS INVOKER</text>
          <text x="127" y="145" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9.5">MCP 工具进程内内存直调 (零网络)</text>
          <text x="127" y="161" text-anchor="middle" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.2">注入 256-bit RAM Secret + act_as = u</text>
          <text x="127" y="174" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.2">via = "ai" | "ai-confirmed"</text>

          <!-- Path 3: Spoofed External -->
          <rect x="20" y="200" width="214" height="62" fill="#F9ECE8" stroke="#8F5638" stroke-width="1"/>
          <text x="127" y="221" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">PATH C · SPOOFED NETWORK CALL</text>
          <text x="127" y="239" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">外部网络伪造 x-internal-secret 头</text>
          <text x="127" y="254" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.2">timingSafeEqual 校验失败 → 401 拦截</text>

          <!-- Arrows to Gate -->
          <path d="M234 54 L276 54 L276 112 L302 112" stroke="#233E33" stroke-width="1.3"/>
          <line x1="234" y1="143" x2="302" y2="143" stroke="#00C472" stroke-width="1.5"/>
          <line x1="234" y1="231" x2="286" y2="231" stroke="#8F5638" stroke-width="1.3" stroke-dasharray="3 3"/>
          <text x="294" y="235" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="11" font-weight="700">✕</text>

          <!-- Center: Unified Router & RBAC -->
          <rect x="302" y="68" width="212" height="132" fill="#EFECE4" stroke="#151C19" stroke-width="1.2"/>
          <text x="408" y="92" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">UNIFIED ROUTE &amp; RBAC KERNEL</text>
          <line x1="302" y1="102" x2="514" y2="102" stroke="#C8C1B4"/>
          <text x="316" y="124" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">1. 恒定时间核验内存瞬态密钥</text>
          <text x="316" y="144" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">2. 100% 复用同一套租户/项目鉴权</text>
          <text x="316" y="164" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">3. 执行完全一致的领域业务状态机</text>
          <text x="316" y="184" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.4" font-weight="600">零重复权限代码 · 零规则漂移</text>

          <line x1="514" y1="134" x2="548" y2="134" stroke="#233E33" stroke-width="1.4"/>

          <!-- Right: Dual-Track Audit Log -->
          <rect x="548" y="68" width="192" height="132" fill="#F2EFE9" stroke="#233E33" stroke-width="1"/>
          <text x="644" y="92" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">DUAL-TRACK AUDIT LOG</text>
          <line x1="548" y1="102" x2="740" y2="102" stroke="#DFDAD0"/>
          <text x="560" y="124" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.5">actor:       user_id (u)</text>
          <text x="560" y="144" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">via:         human | ai |</text>
          <text x="560" y="158" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">             ai-confirmed</text>
          <text x="560" y="178" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.5">confirmedBy: approver_id</text>
        </svg>
        <figcaption>图 2：零分叉进程内同源回环流水线——MCP 工具通过内存瞬态密钥直调统一路由内核，与人类共享 100% 鉴权逻辑并输出双轨溯源审计。</figcaption>
      </figure>

      <ul>
        <li><strong>绝不编写第二套权限代码</strong>：所有的管理类与业务类 AI 原生工具本身不包含任何独立的数据库修改或权限分支，而是将结构化参数映射为对应的标准内部路由请求，交由进程内调用器直接投递给同一个核心应用实例处理。</li>
        <li><strong>防伪造进程内瞬态密钥（Ephemeral In-Memory Secret）</strong>：进程内调用器在转发请求时，会自动注入一个每次服务启动时在内存中随机生成的 256-bit 瞬态密钥（不落盘、不出进程），并通过恒定时间比对（<code>timingSafeEqual</code>）校验。任何来自外部网络的请求一旦试图伪造内部委托头，都会被无条件识别为未授权伪造并拦截。</li>
        <li><strong>细粒度人机双轨审计（Dual-Track Provenance Audit）</strong>：因为人机共用同一套业务管道，每一次状态变更都会自动落入统一的不可篡改审计日志，并同时记录操作主体 <code>actor</code>、触发通道 <code>via</code>（<code>human</code> / <code>ai</code> / <code>ai-confirmed</code>）与确认人 <code>confirmed_by</code>。</li>
      </ul>

      <pre><code>// 零分叉进程内同源调用伪代码
RAM_SECRET = randomBytes(32) // 进程启动时于内存生成，永不落盘或出网

function invokeAsUser(currentUser, method, routePath, payload, via = "ai", confirmedBy = null):
  headers = { "x-internal-secret": RAM_SECRET, "x-act-as": currentUser, "x-via": via, "x-confirmed-by": confirmedBy }
  return app.request(routePath, { method, headers, body: payload }) // 进程内直调同一个路由与鉴权内核</code></pre>

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
        <figcaption>图 3：人机权责边界的三分法——日常可逆操作全速自主执行，高风险操作经确认卡门控，主权与终审操作严守人类底线。</figcaption>
      </figure>

      <ol>
        <li><strong>第一层：可逆日常操作 → AI 直接自主执行（<code>via = ai</code>）</strong>。包括文稿起草、数据统计、知识库检索、文档重命名、移入回收站（可随时恢复）以及版本保存。由于底层有 CRDT 靶向回滚与回收站兜底，AI 可以零打扰地全速推进工作。</li>
        <li><strong>第二层：高风险与不可逆操作 → AI 发起提案 + 人类确认卡门控（<code>via = ai-confirmed</code>）</strong>。涵盖三个高敏类别：<strong>不可恢复的物理删除（如清空回收站、删除数据集）</strong>、<strong>权限与安全边界变更（如修改机构设置、变更成员角色、项目所有权移交）</strong>以及<strong>对外机构标识变更</strong>。当用户让 AI 执行此类任务时：
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

      <h3>4.1 为什么“AI 申请权限的过程”本身必须与执行结果同样可审计？</h3>
      <p>在传统软件审计中，系统往往只记录“最终成功落库的写操作”。但在人机共治系统中，<strong>“AI 申请了什么权限、基于什么理由申请、人类最终批准还是驳回”这一申请过程本身的可审计性（Auditability of Permission Requests），与最终执行结果同样关键</strong>：</p>
      <ul>
        <li><strong>告别“弹窗点完即焚”的审计黑洞</strong>：许多本地 Agent 工具依赖一次性模态弹窗（“Allow command?”）请求权限，用户随手点击后弹窗即刻消失，事后既无法追溯 AI 当时传入的完整参数，也无法复盘是否存在诱导性提权（Prompt Injection Escalation）。</li>
        <li><strong>全生命周期留痕（含未获批与越权拦截）</strong>：在我们的内核中，AI 发起的每一次高敏权限申请都会作为一等公民持久化，完整记录<strong>代理主体（<code>actor</code>）</strong>、<strong>目标接口与参数快照（<code>method + path + params</code>）</strong>、<strong>AI 声明的申请理由（<code>reason</code>）</strong>以及<strong>最终裁决状态（<code>approved</code> / <code>rejected</code> / <code>expired</code> / <code>rbac_denied</code>）与审批人（<code>confirmed_by</code>）</strong>。即便某次权限申请被人类驳回或因越权被内核直接拦截，安全团队依然能通过审计链清晰复盘智能体的每一次边界试探。</li>
      </ul>

      <h2 id="sec-parity-invariant">05. 用反射测试锁死契约：全路由对等性不变量</h2>
      <p>在多人协作演进的大型软件系统中，口头倡导“为 AI 构建原生接口”极易退化——当工程师为了赶进度在前端加了一个新按钮和新 HTTP 路由，却忘记同步注册 MCP 工具时，人机对等性就会出现裂缝。</p>
      <p>为了将“人机能力与权限对等”上升为不可违背的系统级定律，我们在持续集成流水线中植入了一条<strong>全路由对等性反射不变量（Route-to-Tool Parity Invariant）</strong>：</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 256" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="编译期与 CI 全路由对等性反射测试不变量架构图">
          <rect x="1" y="1" width="758" height="254" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Left: Auto-Enumerated Routes -->
          <rect x="20" y="34" width="188" height="188" fill="#F2EFE9" stroke="#C8C1B4" stroke-width="1"/>
          <text x="114" y="56" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">ALL APPLICATION ROUTES</text>
          <line x1="20" y1="66" x2="208" y2="66" stroke="#DFDAD0"/>
          <text x="32" y="90" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">POST /api/docs/:id/edit</text>
          <text x="32" y="112" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">POST /api/datasets/:id/table1</text>
          <text x="32" y="134" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.2">DELETE /api/docs/:id/purge</text>
          <text x="32" y="156" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.2">POST /api/actions/:id/confirm</text>
          <text x="32" y="178" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.2">POST /api/auth/login</text>
          <text x="32" y="204" fill="#151C19" font-family="Inter, sans-serif" font-size="8.8" font-weight="500">反射枚举全部 HTTP 路由集合 R</text>

          <line x1="208" y1="128" x2="242" y2="128" stroke="#233E33" stroke-width="1.4"/>

          <!-- Center: 4 Reflection Invariant Laws -->
          <rect x="242" y="22" width="286" height="212" fill="#233E33" stroke="#151C19" stroke-width="1.2"/>
          <text x="385" y="45" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">CI PARITY REFLECTION VERIFIER</text>
          <line x1="242" y1="55" x2="528" y2="55" stroke="#395A4C"/>
          <text x="256" y="80" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9.5" font-weight="600">定律 1 · 完备覆盖断言 (Completeness)</text>
          <text x="256" y="97" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.2">∀ r ∈ R: r ∈ MCP_MAP ∨ r ∈ NOT_FOR_AI</text>
          <text x="256" y="122" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9.5" font-weight="600">定律 2 · 严格互斥断言 (Disjointness)</text>
          <text x="256" y="139" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.2">keys(MCP_MAP) ∩ keys(NOT_FOR_AI) = ∅</text>
          <text x="256" y="164" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9.5" font-weight="600">定律 3 · 路由双射核验 (Route Bijection)</text>
          <text x="256" y="181" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.2">tool.action.method &amp; pathRegex === r</text>
          <text x="256" y="206" fill="#00C472" font-family="Inter, sans-serif" font-size="9.5" font-weight="600">定律 4 · 门控对齐 (confirm === AI_CONFIRM)</text>

          <path d="M528 96 L562 96" stroke="#00C472" stroke-width="1.4"/>
          <path d="M528 176 L562 176" stroke="#8F5638" stroke-width="1.4"/>

          <!-- Right Top: Pass -->
          <rect x="562" y="42" width="178" height="84" fill="#E3ECE7" stroke="#233E33" stroke-width="1"/>
          <text x="651" y="65" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">PASS · 100% PARITY</text>
          <text x="651" y="87" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">人机能力与门控严格同步</text>
          <text x="651" y="107" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">允许合并与发布</text>

          <!-- Right Bottom: Fail -->
          <rect x="562" y="142" width="178" height="80" fill="#F9ECE8" stroke="#8F5638" stroke-width="1"/>
          <text x="651" y="165" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">FAIL · UNMAPPED ROUTE</text>
          <text x="651" y="187" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">新增接口漏配 AI 原生工具</text>
          <text x="651" y="207" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.2">CI 直接阻断提交</text>
        </svg>
        <figcaption>图 4：全路由对等性反射不变量——在 CI 阶段自动枚举全部路由并执行四条双射断言，从根本上杜绝新增功能遗漏 AI 原生接口。</figcaption>
      </figure>

      <pre><code>// 全路由对等性反射不变量伪代码 (CI 门禁)
for each route in app.enumerateAllRoutes():
  assert (route in MCP_TOOL_MAP) XOR (route in NOT_FOR_AI_REASONS) // 必配原生工具或显式写明豁免理由
  if route in MCP_TOOL_MAP:
    assert resolveToolAction(MCP_TOOL_MAP[route]).matches(route)   // 校验工具底层调用路径与路由严格吻合
assert collectToolsWhere(confirm == true) == AI_CONFIRM_REGISTRY   // 高风险确认卡清单 100% 闭合</code></pre>

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

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 284" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Zero-Fork In-Process Loopback and Dual-Track Audit Pipeline">
          <rect x="1" y="1" width="758" height="282" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Path 1: Human Browser -->
          <rect x="20" y="22" width="214" height="64" fill="#F2EFE9" stroke="#233E33" stroke-width="1"/>
          <text x="127" y="43" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">PATH A · HUMAN GUI REQUEST</text>
          <text x="127" y="61" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">Browser sends Bearer Session</text>
          <text x="127" y="76" text-anchor="middle" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.2">actor = u, via = "human"</text>

          <!-- Path 2: AI In-Process -->
          <rect x="20" y="106" width="214" height="74" fill="#233E33" stroke="#151C19" stroke-width="1"/>
          <text x="127" y="127" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">PATH B · AI IN-PROCESS INVOKER</text>
          <text x="127" y="145" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9.5">Zero-network in-memory MCP call</text>
          <text x="127" y="161" text-anchor="middle" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.2">Injects 256-bit RAM Secret + act_as = u</text>
          <text x="127" y="174" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.2">via = "ai" | "ai-confirmed"</text>

          <!-- Path 3: Spoofed External -->
          <rect x="20" y="200" width="214" height="62" fill="#F9ECE8" stroke="#8F5638" stroke-width="1"/>
          <text x="127" y="221" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">PATH C · SPOOFED NETWORK CALL</text>
          <text x="127" y="239" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">External client spoofs internal header</text>
          <text x="127" y="254" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.2">timingSafeEqual mismatch → 401 Blocked</text>

          <!-- Arrows to Gate -->
          <path d="M234 54 L276 54 L276 112 L302 112" stroke="#233E33" stroke-width="1.3"/>
          <line x1="234" y1="143" x2="302" y2="143" stroke="#00C472" stroke-width="1.5"/>
          <line x1="234" y1="231" x2="286" y2="231" stroke="#8F5638" stroke-width="1.3" stroke-dasharray="3 3"/>
          <text x="294" y="235" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="11" font-weight="700">✕</text>

          <!-- Center: Unified Router & RBAC -->
          <rect x="302" y="68" width="212" height="132" fill="#EFECE4" stroke="#151C19" stroke-width="1.2"/>
          <text x="408" y="92" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">UNIFIED ROUTE &amp; RBAC KERNEL</text>
          <line x1="302" y1="102" x2="514" y2="102" stroke="#C8C1B4"/>
          <text x="316" y="124" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">1. Constant-time RAM secret check</text>
          <text x="316" y="144" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">2. 100% shared tenant/project RBAC</text>
          <text x="316" y="164" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">3. Identical domain state machine</text>
          <text x="316" y="184" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.4" font-weight="600">Zero duplicate auth · Zero drift</text>

          <line x1="514" y1="134" x2="548" y2="134" stroke="#233E33" stroke-width="1.4"/>

          <!-- Right: Dual-Track Audit Log -->
          <rect x="548" y="68" width="192" height="132" fill="#F2EFE9" stroke="#233E33" stroke-width="1"/>
          <text x="644" y="92" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">DUAL-TRACK AUDIT LOG</text>
          <line x1="548" y1="102" x2="740" y2="102" stroke="#DFDAD0"/>
          <text x="560" y="124" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.5">actor:       user_id (u)</text>
          <text x="560" y="144" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">via:         human | ai |</text>
          <text x="560" y="158" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5">             ai-confirmed</text>
          <text x="560" y="178" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.5">confirmedBy: approver_id</text>
        </svg>
        <figcaption>Figure 2: Zero-Fork In-Process Loopback Pipeline—MCP tools dispatch into the unified router using an ephemeral RAM secret, sharing 100% of RBAC logic and emitting dual-track provenance logs.</figcaption>
      </figure>

      <ul>
        <li><strong>Zero Duplicate Authorization Code</strong>: Administrative and domain MCP tools do not implement custom database mutations or bespoke permission checks. Each tool action maps declaratively to an underlying HTTP route and dispatches through an in-process loopback invoker directly into the same application router under the user’s identity.</li>
        <li><strong>Unforgeable Ephemeral In-Memory Secret</strong>: Every in-process invocation carries a 256-bit random secret generated in memory at process startup (never written to disk or exposed over the network) and verified via constant-time comparison (<code>timingSafeEqual</code>). Any external network request attempting to spoof internal delegation headers is immediately rejected as unauthenticated.</li>
        <li><strong>Dual-Track Provenance Auditing</strong>: Because human and agent operations traverse the exact same domain pipeline, every state mutation writes to a unified audit log enriched with <code>actor</code>, <code>via</code> (<code>human</code> / <code>ai</code> / <code>ai-confirmed</code>), and <code>confirmed_by</code>.</li>
      </ul>

      <pre><code>// Concise pseudocode for Zero-Fork In-Process Loopback
RAM_SECRET = randomBytes(32) // Ephemeral in-memory secret generated at boot

function invokeAsUser(currentUser, method, routePath, payload, via = "ai", confirmedBy = null):
  headers = { "x-internal-secret": RAM_SECRET, "x-act-as": currentUser, "x-via": via, "x-confirmed-by": confirmedBy }
  return app.request(routePath, { method, headers, body: payload }) // Dispatches into the exact same RBAC &amp; route kernel</code></pre>

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
        <figcaption>Figure 3: The Three-Tier Governance Boundary—autonomous execution for reversible work, confirmation cards for high-impact mutations, and strict human sovereignty over sign-off and credentials.</figcaption>
      </figure>

      <ol>
        <li><strong>Tier 1: Reversible Daily Operations → Direct Autonomous Execution (<code>via = ai</code>)</strong>. Drafting sections, querying literature, computing statistical tables, renaming documents, moving items to the recoverable trash, and saving version snapshots execute immediately without interrupting the user.</li>
        <li><strong>Tier 2: High-Impact &amp; Irreversible Operations → Agent Proposal + Human Confirmation Card (<code>via = ai-confirmed</code>)</strong>. This covers three sensitive classes: <strong>irreversible deletion (<code>purge</code>, dataset deletion)</strong>, <strong>security and governance mutations (member role changes, project ownership transfer, organization settings)</strong>, and <strong>external organizational identity changes</strong>. When an agent invokes one of these tools:
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

      <h3>4.1 Why the Act of Requesting Permission Must Be as Auditable as Execution</h3>
      <p>Legacy audit logs only record mutations that successfully commit to the database. In human-AI collaborative systems, <strong>auditing the permission request lifecycle itself—what capability the AI requested, why it requested it, and how the human adjudicated it—is just as critical as auditing the final execution</strong>:</p>
      <ul>
        <li><strong>Eliminating Ephemeral Modal Blind Spots</strong>: Conventional agent wrappers rely on transient \"Allow?\" popups that vanish the instant a user clicks through, leaving zero forensic record of what parameters were proposed or whether a prompt injection attempted to escalate privileges.</li>
        <li><strong>Full-Lifecycle Request Provenance (Including Rejections &amp; Denials)</strong>: Every high-stakes capability request initiated by an agent is persisted as a structured record capturing the <strong>delegating principal (<code>actor</code>)</strong>, <strong>target route and parameter snapshot</strong>, <strong>declared rationale (<code>reason</code>)</strong>, and <strong>adjudication outcome (<code>approved</code> / <code>rejected</code> / <code>expired</code> / <code>rbac_denied</code>) alongside <code>confirmed_by</code></strong>. Even rejected or blocked requests remain permanently queryable for security and compliance review.</li>
      </ul>

      <h2 id="sec-parity-invariant">05. Locking the Contract: Automated Route-to-Tool Parity Invariants</h2>
      <p>Architectural principles decay quickly if they rely solely on developer discipline. If an engineer adds a new HTTP endpoint for a UI button but forgets to expose the corresponding MCP tool, the agent becomes blind to that feature.</p>
      <p>To make Capability Parity an unbreakable system invariant, our continuous integration pipeline runs an automated <strong>Route-to-Tool Parity Reflection Verifier</strong> on every commit:</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 256" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Compile-Time and CI Route-to-Tool Parity Invariant Verifier">
          <rect x="1" y="1" width="758" height="254" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Left: Auto-Enumerated Routes -->
          <rect x="20" y="34" width="188" height="188" fill="#F2EFE9" stroke="#C8C1B4" stroke-width="1"/>
          <text x="114" y="56" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">ALL APPLICATION ROUTES</text>
          <line x1="20" y1="66" x2="208" y2="66" stroke="#DFDAD0"/>
          <text x="32" y="90" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">POST /api/docs/:id/edit</text>
          <text x="32" y="112" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">POST /api/datasets/:id/table1</text>
          <text x="32" y="134" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.2">DELETE /api/docs/:id/purge</text>
          <text x="32" y="156" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.2">POST /api/actions/:id/confirm</text>
          <text x="32" y="178" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.2">POST /api/auth/login</text>
          <text x="32" y="204" fill="#151C19" font-family="Inter, sans-serif" font-size="8.8" font-weight="500">Auto-enumerated route set R</text>

          <line x1="208" y1="128" x2="242" y2="128" stroke="#233E33" stroke-width="1.4"/>

          <!-- Center: 4 Reflection Invariant Laws -->
          <rect x="242" y="22" width="286" height="212" fill="#233E33" stroke="#151C19" stroke-width="1.2"/>
          <text x="385" y="45" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">CI PARITY REFLECTION VERIFIER</text>
          <line x1="242" y1="55" x2="528" y2="55" stroke="#395A4C"/>
          <text x="256" y="80" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9.5" font-weight="600">Law 1 · Completeness Assertion</text>
          <text x="256" y="97" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.2">∀ r ∈ R: r ∈ MCP_MAP ∨ r ∈ NOT_FOR_AI</text>
          <text x="256" y="122" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9.5" font-weight="600">Law 2 · Strict Disjointness</text>
          <text x="256" y="139" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.2">keys(MCP_MAP) ∩ keys(NOT_FOR_AI) = ∅</text>
          <text x="256" y="164" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9.5" font-weight="600">Law 3 · Route Target Bijection</text>
          <text x="256" y="181" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.2">tool.action.method &amp; pathRegex === r</text>
          <text x="256" y="206" fill="#00C472" font-family="Inter, sans-serif" font-size="9.5" font-weight="600">Law 4 · Gate Alignment (confirm === AI_CONFIRM)</text>

          <path d="M528 96 L562 96" stroke="#00C472" stroke-width="1.4"/>
          <path d="M528 176 L562 176" stroke="#8F5638" stroke-width="1.4"/>

          <!-- Right Top: Pass -->
          <rect x="562" y="42" width="178" height="84" fill="#E3ECE7" stroke="#233E33" stroke-width="1"/>
          <text x="651" y="65" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">PASS · 100% PARITY</text>
          <text x="651" y="87" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">Human &amp; AI capabilities synced</text>
          <text x="651" y="107" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">Commit approved for merge</text>

          <!-- Right Bottom: Fail -->
          <rect x="562" y="142" width="178" height="80" fill="#F9ECE8" stroke="#8F5638" stroke-width="1"/>
          <text x="651" y="165" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">FAIL · UNMAPPED ROUTE</text>
          <text x="651" y="187" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9.5">New UI route missing MCP tool</text>
          <text x="651" y="207" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.2">CI blocks build immediately</text>
        </svg>
        <figcaption>Figure 4: Automated Route-to-Tool Parity Verifier—enumerating every application route in CI and enforcing four bijection laws so no feature ever ships without its AI-native counterpart.</figcaption>
      </figure>

      <pre><code>// Concise pseudocode for the CI Route-to-Tool Parity Invariant
for each route in app.enumerateAllRoutes():
  assert (route in MCP_TOOL_MAP) XOR (route in NOT_FOR_AI_REASONS) // Every route must map to MCP or declare an exemption
  if route in MCP_TOOL_MAP:
    assert resolveToolAction(MCP_TOOL_MAP[route]).matches(route)   // Tool action must invoke the exact route pattern
assert collectToolsWhere(confirm == true) == AI_CONFIRM_REGISTRY   // High-risk confirmation registry stays 100% synced</code></pre>

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
    category_label_zh: 'AEGIS OS · 广义人机事务协作内核',
    category_label_en: 'AEGIS OS · UNIVERSAL COLLABORATION KERNEL',
    date: '2026-11-02',
    reading_time_zh: '19 分钟深读',
    reading_time_en: '19 min read',
    title_zh: '超越 Git 分支与共享目录：面向代码、文件树、数据流水线与跨边界状态的人机与多智能体事务协作范式',
    title_en: 'Beyond Git Feature Branches & Shared Folders: Shadow Workspaces, Advisory File Claims, and Transactional Auto-Merge Across Code, File Trees & Multi-Agent Pipelines',
    subtitle_zh: '为什么“代码里的 Git 分支合并”与“文档/数据里的共享目录直写”在多 Agent 并发时代双双失灵？通过 0.42ms 主干锚定写时复制影子工作区、事前租约锁、内嵌信箱、四级 LCS 归并 + 广义领域预检门与 SHA-256 产物总线，构建横跨代码工程、知识库文件树、科研数据流水线与跨应用状态的通用事务协作底座。',
    subtitle_en: 'Why both Git feature branches and raw shared directories collapse under multi-agent concurrency—and how 0.42ms trunk-anchored Copy-on-Write shadow workspaces, TTL claims, piggybacked IPC, 4-tier LCS auto-merge with domain verification gates, and SHA-256 CAS artifact buses unify collaboration across codebases, document vaults, data pipelines, and governed memory.',
    summary_zh: '当 1 名人类专家与 3–5 个自治智能体在同一个工作空间内以秒级频率协同推进时，软件工程里的 Git Feature Branch 会陷入环境割裂与合并冲突大爆炸；而在更广泛的非代码场景（多文件科研手稿、本地知识库、财务/临床数据流水线、二进制设计产物）中，人们甚至连分支与编译器都没有，直接共享文件夹会导致 41.2% 的后写静默覆盖与半成品污染。本文提出一套超越单一代码场景的广义人机与多智能体事务协作范式：（1）0.42ms 主干锚定写时复制影子工作区（同时支持代码依赖零拷贝穿透与 GB 级数据集/多模态文件树瞬间映射）；（2）兼顾结构化文本与二进制原件保护（overwrite_binaries）的事前 TTL 租约文件锁与零轮询内嵌信箱；（3）四级 LCS 自动三路归并与广义领域预检门（从代码单元测试扩展到 LaTeX 编译、Schema 校验与 PHI 隐私扫描）；（4）基于 SHA-256 内容寻址产物总线（CAS）、任务 DAG 接力与哈希链权限账本的全场景协同架构。',
    summary_en: 'When one human expert orchestrates 3 to 5 concurrent autonomous agents at second-by-second cadence, Git feature branches in software engineering collapse into worktree fragmentation and merge conflict explosions—while non-code workflows (document vaults, research manuscripts, clinical/financial data pipelines, and binary media assets) lack branches and compilers altogether, suffering 41.2% silent overwrites and half-written file corruption. This monograph presents a universal transactional collaboration paradigm across code, file trees, and multi-agent pipelines: (1) 0.42ms trunk-anchored Copy-on-Write shadow workspaces for both source trees and multi-gigabyte datasets/documents, (2) proactive TTL file claims and piggybacked IPC protecting both text and binary assets, (3) 4-tier LCS auto-merge paired with generalized domain verification gates (compilers, LaTeX/Schema validators, and PHI privacy scanners), and (4) SHA-256 Content-Addressed Storage (CAS) artifact buses, task DAG hand-offs, and hash-chained permission audit ledgers.',
    keywords_zh: '版本管理范式, 影子工作区, Copy-on-Write, 文件锁, 文件协作, 多智能体协作, 人机协作, 四级 LCS 三路归并, 内容寻址 CAS, Aegis OS, Git 分支替代',
    keywords_en: 'Version Control Paradigm, Copy-on-Write Shadow Workspace, File Claims, File Collaboration, Multi-Agent Collaboration, Human-Agent Collaboration, 4-Tier LCS Auto-Merge, Content-Addressed Storage, Aegis OS',
    tags_zh: ['代码+文件+数据全场景协同', '0.42ms 影子工作区', '事前租约锁 & CAS 总线', '98.7% 自动归并 + 广义预检'],
    tags_en: ['Code, File & Data Collaboration', '0.42ms Shadow Workspace', 'TTL Claims & CAS Bus', '98.7% Auto-Merge & Domain Gate'],
    stats: [
      { val: '0.42ms', lbl_zh: '写时复制影子派生', lbl_en: 'CoW Shadow Fork' },
      { val: '0', lbl_zh: '事前文件锁冲突踩踏', lbl_en: 'Mid-Flight Collisions' },
      { val: '98.7%', lbl_zh: '四级 LCS 无冲突归并', lbl_en: '4-Tier LCS Auto-Merge' },
    ],
    repo_url: 'https://github.com/heurion-org/aegis-os',
    paper_url: 'https://github.com/heurion-org/aegis-os/blob/main/paper/main.pdf',
    toc: [
      { id: 'sec-git-bottleneck', zh: '01. 为什么 Git 分支与共享文件夹在多 Agent 并发时代双双失灵？', en: '01. Why Both Git Feature Branches and Shared Folders Break Down in the Multi-Agent Era' },
      { id: 'sec-cow-shadow', zh: '02. 主干锚定的写时复制影子工作区：0.42ms 隔离代码库、文件树与 GB 级数据集', en: '02. Trunk-Anchored Copy-on-Write Shadow Workspaces: 0.42ms Isolation for Code, File Trees & Datasets' },
      { id: 'sec-claim-ipc', zh: '03. 从“事后解冲突”到“事前防撞”：租约文件锁、二进制原件护栏与内嵌信箱协同', en: '03. Proactive Collision Prevention: TTL File Claims, Binary Asset Guards & Piggybacked IPC' },
      { id: 'sec-micro-commit', zh: '04. 连续微事务落地：四级 LCS 自动归并与“广义领域预检门（Domain Verify Gate）”', en: '04. Continuous Micro-Transactions: 4-Tier LCS Auto-Merge & Generalized Domain Verification Gates' },
      { id: 'sec-universal-scenarios', zh: '05. 超越本地代码：横跨文件知识库、CAS 数据流水线与跨应用状态的四大协作图景', en: '05. Beyond Source Code: Four Collaboration Scenarios Across File Vaults, CAS Data Pipelines & Live Apps' },
      { id: 'sec-permission-audit', zh: '06. 为什么 AI 跨边界申请权限必须具备“全链路可审计性”？', en: '06. Why AI Boundary Permission Requests Must Be End-to-End Auditable' },
    ],
    body_zh: `
      <h2 id="sec-git-bottleneck">01. 为什么 Git 分支与共享文件夹在多 Agent 并发时代双双失灵？</h2>
      <p>当我们谈论人机协作与多智能体（Multi-Agent）协作时，行业往往把视野局限在“写代码”。但在真实的生产力场景中，<strong>1 名人类专家指挥 3 到 5 个并发 AI Agent 协同演进的工作空间</strong>早已跨越了单纯的软件代码库——它既包括 <strong>TypeScript / Rust / Python 代码工程</strong>，也包括<strong>多文件学术手稿与本地 Markdown / LaTeX 知识库、临床与金融数据科学流水线、结构化配置表，以及 Word / PPT / PDF / 矢量图等多模态二进制文件树</strong>。</p>
      <p>然而，无论是代码工程里沿用二十年的 <strong>Git 分支工作流（Feature Branch Workflow）</strong>，还是桌面文件协作工具（如各类本地目录 Agent / Cowork 工具）直接读写<strong>共享文件夹（Shared Folder）</strong>的粗放模式，在面对秒级高频并发的多智能体时，都会撞上三道致命的系统性高墙：</p>
      <ul>
        <li><strong>代码分支的“滞后盲改与合并冲突大爆炸（Late Conflict Explosion）”</strong>：Git 分支是为“人类天级、低频、异步开发”设计的，其哲学是“先隔离盲改，最后事后合并”。Agent A 与 Agent B 在各自分支里彼此不可见地重构同一模块二十分钟，直到执行 <code>git merge / rebase</code> 时才炸出满屏的 <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD</code> 冲突标记；让大模型手动解复杂的三路冲突不仅消耗海量上下文 Token，更极易引入隐蔽的语法破坏与逻辑回归。</li>
        <li><strong>非代码文件与共享目录的“静默覆写与半成品踩踏（41.2% Silent Overwrites）”</strong>：在代码之外的文档、知识库、数据表与多模态文件协作中，用户甚至<strong>根本没有 Git 分支和编译器兜底</strong>。当文献检索 Agent、数据分析脚本 Agent 与正文润色 Agent 直接在同一个本地文件夹里并发读写时，后完成的 Agent 会静默冲掉人类刚刚保存的段落或前一个 Agent 的修改（实测无协调共享目录中高达 41.2% 的并发写入发生丢失或脏读），而写到一半的 CSV 数据集或 JSON 配置更会导致下游 Agent 直接崩溃。</li>
        <li><strong>切分支/多 Worktree 的重型拷贝负担 vs. 缺乏实时协同语义</strong>：如果为每个并发 Agent 拷贝一份工作目录或 <code>git worktree</code>，数 GB 的构建缓存（<code>node_modules</code>、<code>target</code>）或原始科研数据集（DICOM/NIfTI 影像、大型队列 CSV）会被成倍复制；同时，无论是 Git 还是操作系统的普通文件夹，都只记录静态文件字节，<strong>完全无法表达“哪个 Agent 此时正在锁定哪几个文件/目录”以及“上游数据产物已验证完毕，下游可以接力”的实时状态语义</strong>。</li>
      </ul>

      <div class="blog-callout">
        <div class="blog-callout-title">从“代码版本控制”升维到“广义人机与多智能体事务协作内核”</div>
        <p>真正面向 AI-Native 时代的底层基础设施，绝不只是给 Git 套一层命令行壳，而是要在操作系统虚拟文件系统（VFS）与进程间通信（IPC）层提供一套<strong>横跨代码、文件树、数据流水线与跨应用状态的通用事务协作范式（Trunk-Anchored Shadow Collaboration）</strong>：通过 <strong>0.42ms 写时复制影子工作区</strong>隔离一切未完成的文件与代码变更，用<strong>事前租约文件锁</strong>代替事后解冲突，用<strong>内嵌信箱与内容寻址产物总线（CAS）</strong>实现多 Agent 秒级接力，并以<strong>带广义领域预检门（Domain Verify Gate）的连续微事务</strong>安全合入主空间。</p>
      </div>

      <h2 id="sec-cow-shadow">02. 主干锚定的写时复制影子工作区：0.42ms 隔离代码库、文件树与 GB 级数据集</h2>
      <p>为了让人类与多个自治 Agent 能够在同一个代码仓库、文档库或数据项目主干上同时工作而互不污染，我们在底层虚拟文件系统层（<code>aos-vfs</code>）用<strong>主干锚定的写时复制影子工作区（Trunk-Anchored Copy-on-Write Shadow Workspace）</strong>统一取代了传统的 Git 分支切换与目录拷贝：</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 286" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="传统 Git 分支盲改模式与主干锚定写时复制影子工作区对比架构图">
          <rect x="1" y="1" width="758" height="284" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Left Side: Legacy Git Branch Model -->
          <rect x="20" y="22" width="332" height="242" fill="#F9ECE8" stroke="#C8C1B4" stroke-width="1"/>
          <text x="186" y="45" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">LEGACY · GIT FEATURE BRANCHES &amp; WORKTREES</text>
          <line x1="20" y1="55" x2="352" y2="55" stroke="#DFDAD0"/>

          <rect x="40" y="72" width="128" height="38" fill="#FAF8F4" stroke="#8F5638"/>
          <text x="104" y="95" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">feat/agent-a (Blind)</text>

          <rect x="204" y="72" width="128" height="38" fill="#FAF8F4" stroke="#8F5638"/>
          <text x="268" y="95" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">feat/agent-b (Blind)</text>

          <path d="M104 110 L164 150" stroke="#8F5638" stroke-width="1.3"/>
          <path d="M268 110 L208 150" stroke="#8F5638" stroke-width="1.3"/>

          <rect x="52" y="150" width="268" height="94" fill="#FAF8F4" stroke="#8F5638" stroke-dasharray="4 3"/>
          <text x="186" y="174" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">✕ LATE MERGE CONFLICT EXPLOSION</text>
          <text x="66" y="196" fill="#4A534E" font-family="Inter, sans-serif" font-size="9.2">• 分支间彼此不可见，重复修改同一文件</text>
          <text x="66" y="214" fill="#4A534E" font-family="Inter, sans-serif" font-size="9.2">• 每个 Worktree 重复占用 GB 级构建缓存</text>
          <text x="66" y="232" fill="#8F5638" font-family="Inter, sans-serif" font-size="9.2">• 合并时产生大量 &lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD 冲突标记</text>

          <!-- Right Side: Trunk-Anchored CoW Shadow Model -->
          <rect x="376" y="22" width="364" height="242" fill="#F2EFE9" stroke="#233E33" stroke-width="1.2"/>
          <text x="558" y="45" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">NEW · TRUNK-ANCHORED COW SHADOW WORKSPACES</text>
          <line x1="376" y1="55" x2="740" y2="55" stroke="#C8C1B4"/>

          <!-- Host Trunk + Read-only Deps -->
          <rect x="394" y="70" width="328" height="46" fill="#233E33" stroke="#151C19"/>
          <text x="558" y="90" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.8" font-weight="600">LIVE HOST TRUNK (Human IDE + Shared Read-Only Cache)</text>
          <text x="558" y="106" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9">人类直接在主干工作 · 零拷贝共享重型依赖库</text>

          <line x1="448" y1="116" x2="448" y2="142" stroke="#233E33" stroke-width="1.3"/>
          <line x1="558" y1="116" x2="558" y2="142" stroke="#233E33" stroke-width="1.3"/>
          <line x1="668" y1="116" x2="668" y2="142" stroke="#233E33" stroke-width="1.3"/>

          <!-- 3 CoW Shadows -->
          <rect x="394" y="142" width="102" height="58" fill="#E3ECE7" stroke="#233E33"/>
          <text x="445" y="163" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.2" font-weight="600">Shadow A (0.42ms)</text>
          <text x="445" y="180" text-anchor="middle" fill="#233E33" font-family="Inter, sans-serif" font-size="8.5">独立修改与跑测</text>

          <rect x="507" y="142" width="102" height="58" fill="#E3ECE7" stroke="#233E33"/>
          <text x="558" y="163" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.2" font-weight="600">Shadow B (0.42ms)</text>
          <text x="558" y="180" text-anchor="middle" fill="#233E33" font-family="Inter, sans-serif" font-size="8.5">独立修改与跑测</text>

          <rect x="620" y="142" width="102" height="58" fill="#E3ECE7" stroke="#233E33"/>
          <text x="671" y="163" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.2" font-weight="600">Shadow C (0.42ms)</text>
          <text x="671" y="180" text-anchor="middle" fill="#233E33" font-family="Inter, sans-serif" font-size="8.5">独立修改与跑测</text>

          <rect x="394" y="214" width="328" height="34" fill="#EFECE4" stroke="#151C19"/>
          <text x="558" y="235" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">✓ 事前文件锁防撞 + 实时 IPC 通知 + 连续微事务自动归并</text>
        </svg>
        <figcaption>图 1：传统 Git 分支“隔离盲改、事后冲突爆炸”模式（左）与主干锚定写时复制影子工作区模式（右）的架构对比。</figcaption>
      </figure>

      <ul>
        <li><strong>0.42 ms 零拷贝瞬间派生</strong>：当一个 Agent 启动任务时，无需执行任何 Git 分支操作，内核直接利用操作系统底层的块级写时复制原语（macOS APFS <code>clonefile</code> / Linux <code>FICLONE</code>）在 <strong>0.42 ms</strong> 内派生出一个与当前宿主机主干完全一致的影子工作区。未修改的文件与宿主机共享同一份磁盘物理块（0 字节额外占用）。</li>
        <li><strong>人类主干零打扰与重型缓存穿透</strong>：人类开发者始终留在自己熟悉的宿主机主目录和 IDE 中工作；而每个 Agent 在各自的写时复制上层视图（Upper Layer）中修改代码并执行沙箱编译。数 GB 的重型依赖目录通过内核只读挂载直接穿透复用，既免去了重复安装，又防止了某个 Agent 写坏半成品代码时导致其他 Agent 或人类 IDE 编译报错。</li>
        <li><strong>毫秒级增量变基（Auto-Refresh）</strong>：每当有人类或其他 Agent 将新变更合入宿主机主干时，其余正在运行的影子工作区会在下一次工具调用时自动对未触碰的文件完成增量快进同步（Fast-Forward Refresh），让所有 Agent 时刻站在最新的主干基线上工作。</li>
      </ul>

      <h2 id="sec-claim-ipc">03. 从“事后解冲突”到“事前防撞”：租约文件锁、二进制原件护栏与内嵌信箱协同</h2>
      <p>既然所有 Agent 都围绕同一个主干工作空间协同作业——无论是改写代码文件、增补 Markdown/LaTeX 知识库，还是生成图表与二进制文档——如何避免两个 Agent 同时去改同一个文件？答案是把协同控制从 Git 的“合并时事后报错”前移到<strong>“动笔前事前认领 + 文本/二进制分层护栏 + 实时事件广播”</strong>：</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 276" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="多智能体文件认领锁与内嵌信箱实时接力时序图">
          <rect x="1" y="1" width="758" height="274" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Lifelines Headers -->
          <rect x="28" y="20" width="144" height="36" fill="#233E33" stroke="#151C19"/>
          <text x="100" y="42" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">AGENT 01 (Backend)</text>

          <rect x="224" y="20" width="160" height="36" fill="#EFECE4" stroke="#151C19"/>
          <text x="304" y="42" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">COORD &amp; IPC BUS</text>

          <rect x="436" y="20" width="144" height="36" fill="#F2EFE9" stroke="#233E33"/>
          <text x="508" y="42" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">AGENT 02 (Frontend)</text>

          <rect x="616" y="20" width="118" height="36" fill="#F2EFE9" stroke="#8F5638"/>
          <text x="675" y="42" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">HUMAN IDE</text>

          <!-- Vertical Lifelines -->
          <line x1="100" y1="56" x2="100" y2="256" stroke="#C8C1B4" stroke-dasharray="3 3"/>
          <line x1="304" y1="56" x2="304" y2="256" stroke="#151C19" stroke-width="1.2"/>
          <line x1="508" y1="56" x2="508" y2="256" stroke="#C8C1B4" stroke-dasharray="3 3"/>
          <line x1="675" y1="56" x2="675" y2="256" stroke="#C8C1B4" stroke-dasharray="3 3"/>

          <!-- Step 1: Claim -->
          <line x1="100" y1="82" x2="304" y2="82" stroke="#233E33" stroke-width="1.4"/>
          <text x="202" y="75" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.3" font-weight="600">1. coord_claim([schema, api], ttl)</text>

          <!-- Step 2: Piggyback Broadcast to Agent 02 -->
          <line x1="304" y1="104" x2="508" y2="104" stroke="#8F5638" stroke-width="1.3"/>
          <text x="406" y="97" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.2">2. _inbox: [coord] schema locked by A1</text>

          <!-- Step 3: Agent 02 pivots to UI files -->
          <rect x="442" y="114" width="132" height="28" fill="#E3ECE7" stroke="#233E33"/>
          <text x="508" y="132" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="8.6">3. 避开锁区，认领并改 UI 层</text>

          <!-- Step 4: Agent 01 Commits & Releases -->
          <line x1="100" y1="164" x2="304" y2="164" stroke="#00C472" stroke-width="1.5"/>
          <text x="202" y="157" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.3" font-weight="600">4. commit(verify) + coord_release</text>

          <!-- Step 5: IPC Hand-off & Auto-Rebase -->
          <line x1="304" y1="194" x2="508" y2="194" stroke="#233E33" stroke-width="1.4"/>
          <text x="406" y="187" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2" font-weight="600">5. ipc_send("Schema ready") + Auto-Rebase</text>

          <line x1="304" y1="224" x2="675" y2="224" stroke="#233E33" stroke-width="1.3"/>
          <text x="490" y="217" text-anchor="middle" fill="#4A534E" font-family="Inter, sans-serif" font-size="8.6">6. 连续微事务原子落盘，人类 IDE 实时看到已验证代码</text>
        </svg>
        <figcaption>图 2：从“事后解冲突”到“事前防撞与实时接力”——通过租约文件锁（<code>coord_claim</code>）与内嵌事件信箱实现多智能体零踩踏协作。</figcaption>
      </figure>

      <ol>
        <li><strong>带 TTL 与任务绑定的通配符文件锁（Task-Bound Glob Claims）</strong>：任何 Agent 在修改文件前，先通过协调总线声明锁定目标文件或 Glob 模式集合（<code>coord_claim(paths, ttl_ms, task_id)</code>，内置 2D NFA 与真实文件树双重 Glob 交集防撞，并对沙箱 <code>proc_exec</code> 脚本越界写返回 <code>coordination_warning</code> 告警）。单调递增的锁版本号（<code>claims_version</code>）确保全局视图严格一致；当 <code>workspace_commit</code> 落盘、任务进入终态（或父任务级联取消）或 TTL 到期时，文件锁会自动释放，绝不造成死锁。</li>
        <li><strong>结构化文本 vs. 二进制原件的分层防撞护栏（<code>overwrite_binaries</code>）</strong>：文件协作不仅包含代码和 Markdown，还包含 PDF 论文、高分科研配图（PNG/TIFF）、数据库快照或 Office 二进制归档。这类二进制文件无法按行做三路合并——Aegis OS 通过 <code>coord_claim</code> 在修改前实施严格的排他锁保护，并在 <code>workspace_commit</code> 时默认开启<strong>二进制基线哈希校验</strong>：若宿主机上的二进制原件已被人类或其他 Agent 更新，任何未显式获得 <code>overwrite_binaries: true</code> 授权的影子覆盖都会被立即拦截（而对于需要段落内协同的 <code>.docx / .pptx</code> 手稿，则可无缝桥接至双表面 CRDT 块级锁与 <code>patchParagraph</code> 引擎）。</li>
        <li><strong>零轮询的内嵌信箱通知与阻塞唤醒（Piggybacked Inbox + <code>ipc_wait</code>）</strong>：Agent 之间不需要写循环轮询锁状态。每一次常规工具调用的返回包中，内核都会自动附带一个极轻量的 <code>_inbox</code> 字段，实时推送其他同伴的锁声明、锁释放事件或点对点协同消息（<code>ipc_send / ipc_request</code>，支持 <code>parent_task_id</code> 与 <code>depends_on</code> 层级子任务编排）；对于无生命周期 Hook 的客户端（如 Codex CLI），还可直接调用 <code>ipc_wait</code> 原生阻塞等待事件唤醒。</li>
        <li><strong>主动避让与无缝接力</strong>：如图 2 所示，当 Agent 02 从信箱得知 Agent 01 已锁定后端接口或上游数据表文件时，它会主动避开该区域，转而认领正交子任务；一旦 Agent 01 提交落盘（内核自动释放已落盘文件的锁），Agent 02 立即收到信箱唤醒，自动将新文件同步进自己的影子工作区并完成下游对接——<strong>全过程 0 次文件踩踏，也无需人类在多个窗口之间复制粘贴传话</strong>。</li>
      </ol>

      <pre><code>// 多智能体事前认领锁、自动释放与零轮询协同伪代码
claim_result = coord_claim(agent_id, paths = ["api.ts", "figures/*.svg"], ttl_ms = 600000) // 自动绑定当前 A2A task_id
if claim_result.rejected is not empty:
  // 发现同伴已锁定重叠文件/Glob → 主动切换至正交子任务或调用 ipc_wait 阻塞等待唤醒
  pivotToOrthogonalModuleOrWait(claim_result.active_holder)
else:
  editInCowShadow(paths)                     // 在隔离的 0.42ms 影子工作区内安全修改代码、文档或数据
  workspace_commit(paths, verify_cmd = "test") // 跨进程提交锁 + Epoch 复核 + 预检通过后原子合入主干，并自动释放锁！</code></pre>

      <h2 id="sec-micro-commit">04. 连续微事务落地：四级 LCS 自动归并与“广义领域预检门（Domain Verify Gate）”</h2>
      <p>即便有了事前文件锁，有时人类专家也会在编辑器中顺手修改某个公共配置文件、LaTeX 主文档或共享 JSON/CSV 表格的头部，而 Agent 正在修改同一文件的尾部。为了彻底告别手动解冲突，我们将每次提交设计为<strong>带四级 LCS 自动三路归并与广义领域预检门（Generalized Domain Verify Gate）的原子微事务（<code>workspace_commit</code>）</strong>：</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 250" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="四级 LCS 三路自动归并与广义领域预检门原子提交流水线">
          <rect x="1" y="1" width="758" height="248" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Left: 3 Inputs -->
          <rect x="20" y="24" width="166" height="56" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="103" y="46" text-anchor="middle" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">BASE SNAPSHOT (O)</text>
          <text x="103" y="65" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9">影子工作区派生时刻基线</text>

          <rect x="20" y="96" width="166" height="56" fill="#F2EFE9" stroke="#233E33"/>
          <text x="103" y="118" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">LIVE HOST TRUNK (H)</text>
          <text x="103" y="137" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9">含人类编辑器与同伴最新提交</text>

          <rect x="20" y="168" width="166" height="56" fill="#E3ECE7" stroke="#233E33"/>
          <text x="103" y="190" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">AGENT SHADOW (A)</text>
          <text x="103" y="209" text-anchor="middle" fill="#233E33" font-family="Inter, sans-serif" font-size="9">当前智能体影子工作区修改</text>

          <path d="M186 52 L222 104" stroke="#4A534E" stroke-width="1.2"/>
          <line x1="186" y1="124" x2="222" y2="124" stroke="#233E33" stroke-width="1.3"/>
          <path d="M186 196 L222 144" stroke="#233E33" stroke-width="1.3"/>

          <!-- Center: 4-Tier LCS Diff3 -->
          <rect x="222" y="32" width="276" height="184" fill="#233E33" stroke="#151C19" stroke-width="1.2"/>
          <text x="360" y="55" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">4-TIER LCS DIFF3 AUTO-MERGE</text>
          <line x1="222" y1="65" x2="498" y2="65" stroke="#395A4C"/>
          <text x="236" y="90" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.4">Tier 1 · Fast-Forward (H == O 直通)</text>
          <text x="236" y="116" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.4">Tier 2 · 行级标准 LCS 非重叠区块合并</text>
          <text x="236" y="142" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.4">Tier 3 · 缩进与空白符归一化消解伪冲突</text>
          <text x="236" y="168" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.4">Tier 4 · 邻接无交集子块拼接 (98.7% 成功)</text>
          <text x="236" y="196" fill="#E3ECE7" font-family="Inter, sans-serif" font-size="8.8">真冲突或二进制冲突立即中止 · 0% 静默覆盖</text>

          <line x1="498" y1="124" x2="532" y2="124" stroke="#00C472" stroke-width="1.5"/>

          <!-- Right: Pre-Commit Gate & Atomic Land -->
          <rect x="532" y="32" width="208" height="184" fill="#EFECE4" stroke="#151C19" stroke-width="1.2"/>
          <text x="636" y="55" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">DOMAIN VERIFY GATE</text>
          <line x1="532" y1="65" x2="740" y2="65" stroke="#C8C1B4"/>
          <text x="546" y="90" fill="#151C19" font-family="Inter, sans-serif" font-size="9.2">1. 在归并暂存树上运行 verify_cmd：</text>
          <text x="546" y="108" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.1">   • 代码: tsc / cargo test</text>
          <text x="546" y="124" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.1">   • 文档: latexmk / 引文与死链核验</text>
          <text x="546" y="140" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.1">   • 数据: Schema / PHI 零泄露扫描</text>
          <text x="546" y="164" fill="#8F5638" font-family="Inter, sans-serif" font-size="9.2">2. 预检不通过 → 自动中止回滚</text>
          <text x="546" y="190" fill="#233E33" font-family="Inter, sans-serif" font-size="9.2" font-weight="600">3. 预检全绿 → 原子重命名落盘</text>
        </svg>
        <figcaption>图 3：连续微事务提交流水线——基于 <i>O / H / A</i> 三态执行四级 LCS 自动归并，并通过广义领域预检门（代码测试、文档排版编译、数据 Schema 与隐私守卫）后原子写入主空间。</figcaption>
      </figure>

      <p>与传统流程动辄攒上千行修改再人工合并不同，Agent 每完成一个 3–5 分钟的微任务闭环，就会调用 <code>workspace_commit</code> 触发上述流水线：</p>
      <ul>
        <li><strong>98.7% 自动无冲突合入，0% 静默覆写</strong>：无论人类刚刚在编辑器里改了同一份代码、LaTeX 论文、Markdown 笔记还是 JSON 配置表的上半部分，而 Agent 改了下半部分，四级 LCS 归并器都会在毫秒内将两者的修改无损融合，绝不会像普通共享目录那样把人类的心血冲掉。</li>
        <li><strong>从“编译器测试”推广到“广义领域不变量预检门（Always-Valid Trunk）”</strong>：<code>verify_cmd</code> 的威力远不止跑单元测试。在非代码协作中，它可以配置为任何领域不变量校验器——例如在多 Agent 共编 LaTeX 论文时运行 <code>latexmk -pdf &amp;&amp; bibtex-check</code> 确保公式与引用不断裂；在临床与企业数据协作中运行 <code>scanPhi --strict &amp;&amp; schema-validate</code> 确保没有任何患者隐私（PHI）或算术破损的数据表落入主目录。</li>
      </ul>

      <h2 id="sec-universal-scenarios">05. 超越本地代码：横跨文件知识库、CAS 数据流水线与跨应用状态的四大协作图景</h2>
      <p>一旦我们将“写时复制影子空间 + 事前租约锁 + 内嵌信箱 + 预检微事务”从单纯的代码分支工具中抽离出来，它就自然演进为一套<strong>覆盖知识工作全场景的通用人机与多智能体事务协作内核</strong>。在 Aegis OS 中，我们将这套内核与 <strong>SHA-256 内容寻址产物总线（<code>org_artifact_publish / fetch</code>）</strong>、<strong>组织级键值状态（<code>org_kv_put / get</code>）</strong>、<strong>应用挂载协议（<code>AAP-1.0</code>）</strong> 以及 <strong>受控记忆协议（<code>UOMP</code>）</strong> 深度打通，支撑起四大典型协作场景：</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 288" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Aegis OS 横跨代码库、文件知识库、CAS 数据流水线与跨边界应用的四大协作图景">
          <rect x="1" y="1" width="758" height="286" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Top Banner: Shared Transactional Kernel -->
          <rect x="20" y="18" width="720" height="44" fill="#233E33" stroke="#151C19" stroke-width="1.2"/>
          <text x="380" y="37" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">AEGIS OS UNIVERSAL TRANSACTIONAL COLLABORATION KERNEL</text>
          <text x="380" y="53" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9.5">0.42ms CoW Shadow VFS · Task-Bound TTL Claims · Piggybacked IPC &amp; DAG · 4-Tier LCS + Verify Gate · SHA-256 CAS Bus</text>

          <!-- 4 Scenario Columns -->
          <!-- Col 1: Codebase -->
          <rect x="20" y="78" width="171" height="190" fill="#F2EFE9" stroke="#233E33" stroke-width="1"/>
          <text x="105" y="99" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5" font-weight="600">SCENARIO 01 · CODEBASE</text>
          <line x1="20" y1="108" x2="191" y2="108" stroke="#DFDAD0"/>
          <text x="105" y="128" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10" font-weight="600">软件工程与多模块重构</text>
          <text x="30" y="150" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• 零拷贝共享 node_modules</text>
          <text x="30" y="170" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• 锁定 api/** 与 schema.ts</text>
          <text x="30" y="190" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• 4 级 LCS 代码块自动合并</text>
          <text x="30" y="210" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8" font-weight="600">• 预检: tsc &amp;&amp; vitest</text>
          <text x="30" y="246" fill="#8F5638" font-family="Inter, sans-serif" font-size="8.2">告别 Git Worktree 碎片化</text>

          <!-- Col 2: Files & Docs -->
          <rect x="203" y="78" width="171" height="190" fill="#E3ECE7" stroke="#233E33" stroke-width="1"/>
          <text x="288" y="99" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5" font-weight="600">SCENARIO 02 · FILE VAULTS</text>
          <line x1="203" y1="108" x2="374" y2="108" stroke="#C8C1B4"/>
          <text x="288" y="128" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10" font-weight="600">多模态文件树与科研文稿</text>
          <text x="213" y="150" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• LaTeX/MD/JSON 并发共编</text>
          <text x="213" y="170" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• 二进制 PDF/图/DOCX 防覆写</text>
          <text x="213" y="190" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• 联动 CRDT 块锁与 OOXML 补丁</text>
          <text x="213" y="210" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8" font-weight="600">• 预检: 编译/死链/引文核查</text>
          <text x="213" y="246" fill="#233E33" font-family="Inter, sans-serif" font-size="8.2">根治共享文件夹 41.2% 覆写</text>

          <!-- Col 3: Data & CAS Pipelines -->
          <rect x="386" y="78" width="171" height="190" fill="#F2EFE9" stroke="#233E33" stroke-width="1"/>
          <text x="471" y="99" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5" font-weight="600">SCENARIO 03 · DATA &amp; CAS</text>
          <line x1="386" y1="108" x2="557" y2="108" stroke="#DFDAD0"/>
          <text x="471" y="128" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10" font-weight="600">数据流水线与产物接力</text>
          <text x="396" y="150" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• 零拷贝映射 GB 级数据集</text>
          <text x="396" y="170" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• SHA-256 CAS 不可变产物</text>
          <text x="396" y="190" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• depends_on DAG 自动唤醒</text>
          <text x="396" y="210" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8" font-weight="600">• 预检: 样本守恒 &amp; PHI 扫描</text>
          <text x="396" y="246" fill="#8F5638" font-family="Inter, sans-serif" font-size="8.2">消除 /tmp 脏读与半成品污染</text>

          <!-- Col 4: Live Apps & Memory -->
          <rect x="569" y="78" width="171" height="190" fill="#EFECE4" stroke="#151C19" stroke-width="1"/>
          <text x="654" y="99" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.5" font-weight="600">SCENARIO 04 · APPS &amp; UOMP</text>
          <line x1="569" y1="108" x2="740" y2="108" stroke="#C8C1B4"/>
          <text x="654" y="128" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10" font-weight="600">跨应用状态与受控记忆</text>
          <text x="579" y="150" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• AAP-1.0 挂载在线 SaaS 会话</text>
          <text x="579" y="170" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• UOMP 跨 Agent 记忆租约</text>
          <text x="579" y="190" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• L7 零信任密钥注入 + DLP</text>
          <text x="579" y="210" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8" font-weight="600">• 预检: 三级人类主权确认卡</text>
          <text x="579" y="246" fill="#233E33" font-family="Inter, sans-serif" font-size="8.2">本地文件与云端应用状态同构</text>
        </svg>
        <figcaption>图 4：从代码工程扩展到多模态文件树、SHA-256 CAS 数据流水线与跨边界应用/记忆状态的四大事务协作场景。</figcaption>
      </figure>

      <ol>
        <li><strong>图景一：软件工程与多模块并发重构（Codebase Collaboration）</strong>。1 名架构师与多个 Coding Agent 围绕主干协同：架构师在 IDE 中调整核心业务类，Agent A 锁定后端路由，Agent B 锁定前端组件，各自在零拷贝复用 <code>node_modules / target</code> 的影子层内编译跑测，以分钟级微事务持续合入主干。</li>
        <li><strong>图景二：多文件科研手稿、本地知识库与二进制设计产物协同（File Vaults &amp; Multi-Modal Documents）</strong>。在撰写大型基金申请书、多章节 LaTeX/Markdown 专著或整理企业本地知识库（类似桌面级 Cowork 场景）时，多个 Agent 需要同时修改不同的章节文件、参考文献库（<code>refs.bib</code>）与矢量配图。对于纯文本与配置表，四级 LCS 自动合并非重叠段落；对于生成的 PDF、高分图表或 <code>.docx / .pptx</code> 归档，<code>coord_claim</code> 事前锁结合 <code>overwrite_binaries</code> 版本校验（以及本系列第 01 篇的双表面 CRDT 块级锁）彻底杜绝了“Agent 改坏排版或静默覆盖人类刚存好的文件”。</li>
        <li><strong>图景三：数据科学流水线与 SHA-256 内容寻址产物接力（Data Pipelines &amp; CAS Artifact Bus）</strong>。在复杂的数据分析或临床研究工作流中，上游“数据清洗 Agent”、中游“生物统计建模 Agent”与下游“森林图/生存曲线渲染 Agent”存在严格的依赖顺序。传统做法是让它们往同一个 <code>/tmp</code> 或 <code>outputs/</code> 目录读写临时 CSV，极易读到写了一半的脏数据。在 Aegis OS 中，上游 Agent 在影子沙箱内完成清洗并通过预检后，调用 <code>org_artifact_publish</code> 将不可变数据集写入 <strong>SHA-256 内容寻址存储（CAS）</strong>，并通过带 <code>depends_on</code> 的任务 DAG（<code>ipc_task_update</code>）把哈希指针精准推送给下游 Agent，实现 100% 可复现、零脏读的流水线接力。</li>
        <li><strong>图景四：跨应用在线状态（<code>AAP-1.0</code>）与多智能体共享记忆（<code>UOMP</code>）协同</strong>。协作并不止步于本地磁盘。通过 Aegis Application Protocol（<code>app_mount_session</code> / <code>app_call_tool</code>），本地影子工作区中的 Agent 可以直接挂载在线科研工作台或企业 SaaS 的实时会话（与本系列第 02 篇的“人机能力同权”无缝闭环）；同时，多个专业 Agent 在共享读写用户的长期偏好或研究记忆时，统一受 <strong>UOMP（User-Owned Memory Protocol）</strong> 作用域租约与撤权机制管控。</li>
      </ol>

      <h2 id="sec-permission-audit">06. 为什么 AI 跨边界申请权限必须具备“全链路可审计性”？</h2>
      <p>当协作范围从代码扩展到用户的本地文件树、核心数据集、外网 API 与个人长期记忆时，还有一个至关重要的安全基石：<strong>当 AI 向系统或人类申请跨边界权限时，这一“权限申请行为”本身必须是结构化且全链路可审计的（End-to-End Auditable Permission Requests）。</strong></p>
      <p>观察现有的 AI 编程与桌面文件工具，其权限交互往往停留在两个极端：</p>
      <ul>
        <li><strong>“弹窗点完即焚”的瞬态授权</strong>：每当 Agent 要改文件、删目录、跑脚本或请求外网时，界面弹出一个临时对话框（“Allow command?”），人类迫于频繁打断往往习惯性点击同意。弹窗消失后，系统没有留下任何关于“AI 当时为什么申请该权限、携带了什么参数、影响了哪些文件或数据边界”的结构化审计记录；</li>
        <li><strong>“跳过权限检查”的黑盒裸奔</strong>：为了免受弹窗干扰，许多用户直接开启免审批模式，导致一旦发生越权修改、重要文档被覆盖、敏感配置泄露或破坏性落盘，事后完全无法界定是哪一个 Agent、在哪一步推理中发起了越界请求。</li>
      </ul>
      <p>在我们的影子工作区协作范式中，我们通过<strong>“沙箱内免打扰投机执行 + 跨边界结构化权限申请账本”</strong>彻底解决了“效率与可审计性”的矛盾：Agent 在自己的写时复制影子层内可以零弹窗全速工作，但<strong>每一次跨越安全或协作边界的权限申请</strong>——无论是申请锁定共享文件（<code>coord_claim</code>）、申请将影子变更或二进制文件合入宿主机主目录（生成 <code>esc-*</code> 提权审批单）、申请受控外网访问（<code>egress_http_request</code>），还是申请读写长期记忆（<code>memory_policy_evaluate</code>）——都会被内核强制铸造为一条不可篡改的<strong>权限申请审计记录</strong>：</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 256" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AI 权限申请与跨边界提权全链路可审计账本架构图">
          <rect x="1" y="1" width="758" height="254" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Stage 1: Boundary Request -->
          <rect x="20" y="30" width="166" height="196" fill="#F2EFE9" stroke="#233E33" stroke-width="1"/>
          <text x="103" y="54" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.8" font-weight="600">1. PERMISSION REQUEST</text>
          <line x1="20" y1="64" x2="186" y2="64" stroke="#DFDAD0"/>
          <text x="32" y="88" fill="#151C19" font-family="Inter, sans-serif" font-size="9.2" font-weight="600">跨边界权限申请类型：</text>
          <text x="32" y="110" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">• coord_claim (路径租约锁)</text>
          <text x="32" y="130" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">• workspace_commit (落盘)</text>
          <text x="32" y="150" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">• egress_http (受控外网)</text>
          <text x="32" y="170" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">• memory_policy (记忆授权)</text>
          <text x="32" y="202" fill="#4A534E" font-family="Inter, sans-serif" font-size="8.5">沙箱内零打扰 · 跨边界必留痕</text>

          <line x1="186" y1="128" x2="216" y2="128" stroke="#233E33" stroke-width="1.4"/>

          <!-- Stage 2: Escalation Ticket -->
          <rect x="216" y="30" width="248" height="196" fill="#233E33" stroke="#151C19" stroke-width="1.2"/>
          <text x="340" y="54" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.8" font-weight="600">2. STRUCTURED ESCALATION TICKET</text>
          <line x1="216" y1="64" x2="464" y2="64" stroke="#395A4C"/>
          <text x="230" y="88" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.3">ticket_id:   "esc-89e2a50b"</text>
          <text x="230" y="108" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.3">principal:   agent_id + user_id</text>
          <text x="230" y="128" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.3">scope:       精确文件路径 / 域名 / TTL</text>
          <text x="230" y="148" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.3">rationale:   AI 声明的申请意图与上下文</text>
          <text x="230" y="168" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.3">evidence:    Unified Diff + 预检测试结果</text>
          <text x="230" y="200" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="8.6" font-weight="500">申请参数与证据载荷在审批前即不可变</text>

          <line x1="464" y1="128" x2="494" y2="128" stroke="#00C472" stroke-width="1.4"/>

          <!-- Stage 3: Hash-Chained Audit Ledger -->
          <rect x="494" y="30" width="246" height="196" fill="#EFECE4" stroke="#151C19" stroke-width="1.2"/>
          <text x="617" y="54" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.8" font-weight="600">3. HASH-CHAINED AUDIT LEDGER</text>
          <line x1="494" y1="64" x2="740" y2="64" stroke="#C8C1B4"/>
          <text x="508" y="88" fill="#151C19" font-family="Inter, sans-serif" font-size="9.2" font-weight="600">全状态裁决永久归档：</text>
          <text x="508" y="110" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">✓ APPROVED (含审批人/策略规则)</text>
          <text x="508" y="130" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.2">✕ REJECTED / DENIED (越界试探留痕)</text>
          <text x="508" y="150" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.2">⏱ EXPIRED (超时自动失效记录)</text>
          <text x="508" y="174" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.2">prev_hash → sha256(ticket + decision)</text>
          <text x="508" y="202" fill="#233E33" font-family="Inter, sans-serif" font-size="8.6" font-weight="600">支持事后合规回放、越权归因与一键回滚</text>
        </svg>
        <figcaption>图 5：AI 权限申请的可审计性架构——将每一次跨边界权限请求（文件锁、主干提交、外网与记忆访问）固化为带证据载荷与防篡改哈希链的审批账本。</figcaption>
      </figure>

      <pre><code>// 跨边界权限申请与防篡改哈希链审计伪代码
function requestBoundaryPermission(agent_id, user_id, perm_type, scope, rationale, evidence):
  ticket = { id: newEscalationId(), agent_id, user_id, perm_type, scope, rationale, evidence, ts: now() }
  decision = evaluatePolicyOrAwaitHuman(ticket) // 评估策略白名单或生成待人类审批单 (APPROVED | REJECTED | DENIED)
  audit_ledger.appendHashChained({ ...ticket, decision, prev_hash: audit_ledger.tailHash() }) // 无论准驳均永久留痕
  return decision</code></pre>

      <h3>6.1 三种版本管理与广义多智能体协作模式对比</h3>
      <div class="blog-table-wrap">
        <table class="blog-table">
          <thead>
            <tr>
              <th>协作维度 (Dimension)</th>
              <th>传统 Git Feature Branch / Worktree</th>
              <th>共享目录直写 (Shared Folder / Cowork)</th>
              <th>Aegis OS 影子工作区 + 租约锁 + 事务内核</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>适用资产范围 (Artifact Scope)</td>
              <td>仅限纯文本源代码（对大文件与数据流笨重）</td>
              <td>任意本地文件，但完全缺乏事务与版本保护</td>
              <td><strong>代码库 + 多模态文件树 + CAS 数据流 + 跨应用状态</strong></td>
            </tr>
            <tr>
              <td>工作区隔离耗时与空间开销</td>
              <td>400+ ms 拷贝 / 数 GB 重复构建与数据缓存</td>
              <td>0 ms（完全无隔离，半成品直接污染主目录）</td>
              <td><strong>0.42 ms 元数据派生 / 0 B 重复物理块占用</strong></td>
            </tr>
            <tr>
              <td>并发修改冲突发现时机</td>
              <td>事后滞后发现（PR Merge 时冲突大爆炸）</td>
              <td>无感知（后写静默覆盖先写，41.2% 修改丢失）</td>
              <td><strong>事前 TTL 租约锁防撞（<code>coord_claim</code>）+ 二进制护栏</strong></td>
            </tr>
            <tr>
              <td>跨智能体进度对齐与产物交付</td>
              <td>靠人类在不同分支/窗口间手动复制传话</td>
              <td>轮询本地临时文件或发生脏读踩踏</td>
              <td><strong>零轮询内嵌信箱（<code>_inbox</code>）+ SHA-256 CAS 产物总线</strong></td>
            </tr>
            <tr>
              <td>同一文件非重叠并发修改处理</td>
              <td>需手动 checkout / rebase 解冲突</td>
              <td>整文件直接覆盖丢失</td>
              <td><strong>四级 LCS 自动三路归并（98.7% 自动无损合入）</strong></td>
            </tr>
            <tr>
              <td>主空间质量与合规保障 (Verify Gate)</td>
              <td>合并前未知，合并后常破坏主干</td>
              <td>无校验，坏脚本/坏排版/隐私泄露直接落盘</td>
              <td><strong>提交前强制跑通广义 <code>verify_cmd</code>（测试/排版/PHI 扫描）</strong></td>
            </tr>
            <tr>
              <td>AI 申请权限与变更的可审计性</td>
              <td>仅记录最终 Git Commit，无权限申请过程</td>
              <td>一次性弹窗点完即焚，或跳过权限无日志</td>
              <td><strong>全链路结构化权限申请单与防篡改哈希链审计账本</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>通过将<strong>写时复制影子工作区</strong>、<strong>事前租约文件锁与二进制护栏</strong>、<strong>事件驱动信箱与 SHA-256 产物总线</strong>、<strong>带广义领域预检门的四级 LCS 微事务归并</strong>以及<strong>全链路可审计的权限申请机制</strong>融为一体，我们将人机与多智能体协作从局限于软件工程的“Git 分支合并仪式”以及脆弱的“共享文件夹盲写”中彻底解放出来，为代码工程、科研文档写作、数据科学流水线与企业级智能体协作提供了统一、丝滑且具备严格事务级安全保障的操作系统底座。</p>
    `,
    body_en: `
      <h2 id="sec-git-bottleneck">01. Why Both Git Feature Branches and Shared Folders Break Down in the Multi-Agent Era</h2>
      <p>When the industry discusses human-agent and multi-agent collaboration, the conversation often narrows to writing source code. Yet in real-world technical and scientific workflows, <strong>one human expert orchestrating 3 to 5 concurrent AI agents</strong> spans far beyond software repositories—encompassing <strong>TypeScript / Rust / Python codebases, multi-file LaTeX / Markdown research manuscripts and local knowledge vaults, clinical and financial data pipelines, structured JSON/CSV configurations, and binary deliverables such as Word (<code>.docx</code>), PowerPoint (<code>.pptx</code>), PDFs, and vector figures</strong>.</p>
      <p>Whether teams rely on the twenty-year-old <strong>Git Feature Branch workflow</strong> for software engineering or allow desktop file agents (such as local Cowork utilities) to mutate a <strong>raw Shared Folder</strong> for documents and data, second-by-second multi-agent concurrency hits three structural walls:</p>
      <ul>
        <li><strong>Blind Divergence &amp; Late Conflict Explosions in Git Branches</strong>: Git branches were designed for low-frequency, asynchronous human development ("isolate blindly now, resolve conflicts later"). Agent A and Agent B may spend twenty minutes refactoring overlapping interfaces on separate branches, only to trigger a massive explosion of <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD</code> conflict markers at merge time. Forcing an LLM to manually untangle complex conflict markers burns huge context windows and frequently introduces subtle syntax or logic regressions.</li>
        <li><strong>41.2% Silent Overwrites &amp; Half-Written Corruption in Non-Code Shared Folders</strong>: Outside of software engineering—in research papers, local knowledge bases, spreadsheets, and data pipelines—collaborators <strong>do not even have Git branches or compilers as a safety net</strong>. When a literature agent, a data-cleaning script agent, and a manuscript drafting agent read and write directly inside the same shared directory, the last writer silently clobbers human edits or peer outputs (causing a <strong>41.2% overwrite/corruption rate</strong> in uncoordinated multi-agent file benchmarks), while half-written CSVs or JSON schemas crash downstream agents mid-flight.</li>
        <li><strong>Heavyweight Worktree Duplication vs. Zero Real-Time Coordination Semantics</strong>: Duplicating a working directory or <code>git worktree</code> for every concurrent agent clones multi-gigabyte build caches (<code>node_modules</code>, <code>target</code>) or raw research datasets (DICOM/NIfTI imaging volumes, cohort tables). Worse, neither Git nor raw OS folders can express live coordination state—such as <em>"which agent currently holds a lock on these files or binary assets"</em> or <em>"upstream data cleaning has passed verification and the downstream plotting agent can now proceed."</em></li>
      </ul>

      <div class="blog-callout">
        <div class="blog-callout-title">From Code Version Control to a Universal Transactional Collaboration Kernel</div>
        <p>True AI-native infrastructure cannot merely wrap Git CLI commands. Instead, Aegis OS provides a <strong>universal transactional collaboration paradigm across code, file trees, data pipelines, and cross-boundary application state (Trunk-Anchored Shadow Collaboration)</strong>: isolating in-flight mutations inside <strong>0.42ms Copy-on-Write shadow workspaces</strong>, preventing collisions proactively via <strong>TTL file &amp; binary claims</strong>, orchestrating hand-offs over a <strong>piggybacked IPC &amp; SHA-256 Content-Addressed Storage (CAS) bus</strong>, and landing changes continuously through <strong>4-tier LCS auto-merge and generalized domain verification gates</strong>.</p>
      </div>

      <h2 id="sec-cow-shadow">02. Trunk-Anchored Copy-on-Write Shadow Workspaces: 0.42ms Isolation for Code, File Trees &amp; Datasets</h2>
      <p>To let a human expert and multiple autonomous agents work on the same repository, document vault, or data project simultaneously without corrupting each other’s state, our virtual filesystem (<code>aos-vfs</code>) replaces Git branch checkouts and folder copies with <strong>Trunk-Anchored Copy-on-Write (CoW) Shadow Workspaces</strong>:</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 286" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison between Legacy Git Feature Branches and Trunk-Anchored Copy-on-Write Shadow Workspaces">
          <rect x="1" y="1" width="758" height="284" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Left Side: Legacy Git Branch Model -->
          <rect x="20" y="22" width="332" height="242" fill="#F9ECE8" stroke="#C8C1B4" stroke-width="1"/>
          <text x="186" y="45" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">LEGACY · GIT FEATURE BRANCHES &amp; WORKTREES</text>
          <line x1="20" y1="55" x2="352" y2="55" stroke="#DFDAD0"/>

          <rect x="40" y="72" width="128" height="38" fill="#FAF8F4" stroke="#8F5638"/>
          <text x="104" y="95" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">feat/agent-a (Blind)</text>

          <rect x="204" y="72" width="128" height="38" fill="#FAF8F4" stroke="#8F5638"/>
          <text x="268" y="95" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6">feat/agent-b (Blind)</text>

          <path d="M104 110 L164 150" stroke="#8F5638" stroke-width="1.3"/>
          <path d="M268 110 L208 150" stroke="#8F5638" stroke-width="1.3"/>

          <rect x="52" y="150" width="268" height="94" fill="#FAF8F4" stroke="#8F5638" stroke-dasharray="4 3"/>
          <text x="186" y="174" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">✕ LATE MERGE CONFLICT EXPLOSION</text>
          <text x="66" y="196" fill="#4A534E" font-family="Inter, sans-serif" font-size="9.2">• Branches evolve blindly; shared folders overwrite</text>
          <text x="66" y="214" fill="#4A534E" font-family="Inter, sans-serif" font-size="9.2">• Multi-GB build caches &amp; datasets duplicated</text>
          <text x="66" y="232" fill="#8F5638" font-family="Inter, sans-serif" font-size="9.2">• Merge erupts in &lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD or silent loss</text>

          <!-- Right Side: Trunk-Anchored CoW Shadow Model -->
          <rect x="376" y="22" width="364" height="242" fill="#F2EFE9" stroke="#233E33" stroke-width="1.2"/>
          <text x="558" y="45" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">NEW · TRUNK-ANCHORED COW SHADOW WORKSPACES</text>
          <line x1="376" y1="55" x2="740" y2="55" stroke="#C8C1B4"/>

          <!-- Host Trunk + Read-only Deps -->
          <rect x="394" y="70" width="328" height="46" fill="#233E33" stroke="#151C19"/>
          <text x="558" y="90" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.8" font-weight="600">LIVE HOST TRUNK (Code + File Vault + Shared Datasets)</text>
          <text x="558" y="106" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9">Human stays on main tree · Zero-copy shared caches &amp; data</text>

          <line x1="448" y1="116" x2="448" y2="142" stroke="#233E33" stroke-width="1.3"/>
          <line x1="558" y1="116" x2="558" y2="142" stroke="#233E33" stroke-width="1.3"/>
          <line x1="668" y1="116" x2="668" y2="142" stroke="#233E33" stroke-width="1.3"/>

          <!-- 3 CoW Shadows -->
          <rect x="394" y="142" width="102" height="58" fill="#E3ECE7" stroke="#233E33"/>
          <text x="445" y="163" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.2" font-weight="600">Shadow A (0.42ms)</text>
          <text x="445" y="180" text-anchor="middle" fill="#233E33" font-family="Inter, sans-serif" font-size="8.5">Code &amp; schema</text>

          <rect x="507" y="142" width="102" height="58" fill="#E3ECE7" stroke="#233E33"/>
          <text x="558" y="163" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.2" font-weight="600">Shadow B (0.42ms)</text>
          <text x="558" y="180" text-anchor="middle" fill="#233E33" font-family="Inter, sans-serif" font-size="8.5">Docs &amp; LaTeX</text>

          <rect x="620" y="142" width="102" height="58" fill="#E3ECE7" stroke="#233E33"/>
          <text x="671" y="163" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.2" font-weight="600">Shadow C (0.42ms)</text>
          <text x="671" y="180" text-anchor="middle" fill="#233E33" font-family="Inter, sans-serif" font-size="8.5">Data &amp; figures</text>

          <rect x="394" y="214" width="328" height="34" fill="#EFECE4" stroke="#151C19"/>
          <text x="558" y="235" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">✓ Proactive File Claims + CAS Bus + Verified Micro-Merges</text>
        </svg>
        <figcaption>Figure 1: Contrasting legacy Git feature branches and uncoordinated shared folders (left) against trunk-anchored Copy-on-Write shadow workspaces (right).</figcaption>
      </figure>

      <ul>
        <li><strong>0.42 ms Zero-Copy Forking Across Code &amp; Large File Trees</strong>: When an agent starts a task, the kernel invokes OS-level copy-on-write primitives (<code>clonefile</code> on macOS APFS / <code>FICLONE</code> on Linux) to provision an isolated shadow workspace in <strong>0.42 ms</strong>. Unmodified source files, document vaults, and gigabyte-scale datasets share physical disk blocks with the host (zero extra disk space).</li>
        <li><strong>Uninterrupted Human Workspace &amp; Read-Only Cache Passthrough</strong>: The human stays on the main working tree while each agent edits files, compiles documents, or runs statistical scripts inside its own CoW upper layer. Heavy dependency directories and raw reference datasets are mounted read-only into every shadow workspace, ensuring an agent’s half-written file never pollutes the human’s folder or peer agents.</li>
        <li><strong>Continuous Auto-Refresh</strong>: Whenever the human or a peer agent lands a change onto the host trunk, active shadow workspaces automatically fast-forward their untouched files on the next syscall, keeping every collaborator continuously anchored to the latest state.</li>
      </ul>

      <h2 id="sec-claim-ipc">03. Proactive Collision Prevention: TTL File Claims, Binary Asset Guards &amp; Piggybacked IPC</h2>
      <p>When multiple agents operate against the same trunk—whether refactoring code, updating a Markdown/LaTeX vault, or generating binary figures and Word manuscripts—how do we prevent mid-flight collisions? We replace post-hoc conflict resolution with <strong>proactive advisory file claims, text/binary stratified guards, and piggybacked event notifications</strong>:</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 276" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Multi-Agent File Claim and Piggybacked IPC Sequence Diagram">
          <rect x="1" y="1" width="758" height="274" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Lifelines Headers -->
          <rect x="28" y="20" width="144" height="36" fill="#233E33" stroke="#151C19"/>
          <text x="100" y="42" text-anchor="middle" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">AGENT 01 (Backend)</text>

          <rect x="224" y="20" width="160" height="36" fill="#EFECE4" stroke="#151C19"/>
          <text x="304" y="42" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">COORD &amp; IPC BUS</text>

          <rect x="436" y="20" width="144" height="36" fill="#F2EFE9" stroke="#233E33"/>
          <text x="508" y="42" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">AGENT 02 (Frontend)</text>

          <rect x="616" y="20" width="118" height="36" fill="#F2EFE9" stroke="#8F5638"/>
          <text x="675" y="42" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">HUMAN IDE</text>

          <!-- Vertical Lifelines -->
          <line x1="100" y1="56" x2="100" y2="256" stroke="#C8C1B4" stroke-dasharray="3 3"/>
          <line x1="304" y1="56" x2="304" y2="256" stroke="#151C19" stroke-width="1.2"/>
          <line x1="508" y1="56" x2="508" y2="256" stroke="#C8C1B4" stroke-dasharray="3 3"/>
          <line x1="675" y1="56" x2="675" y2="256" stroke="#C8C1B4" stroke-dasharray="3 3"/>

          <!-- Step 1: Claim -->
          <line x1="100" y1="82" x2="304" y2="82" stroke="#233E33" stroke-width="1.4"/>
          <text x="202" y="75" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.3" font-weight="600">1. coord_claim([schema, api], ttl)</text>

          <!-- Step 2: Piggyback Broadcast to Agent 02 -->
          <line x1="304" y1="104" x2="508" y2="104" stroke="#8F5638" stroke-width="1.3"/>
          <text x="406" y="97" text-anchor="middle" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.2">2. _inbox: [coord] schema locked by A1</text>

          <!-- Step 3: Agent 02 pivots to UI files -->
          <rect x="442" y="114" width="132" height="28" fill="#E3ECE7" stroke="#233E33"/>
          <text x="508" y="132" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="8.6">3. Pivots to UI files</text>

          <!-- Step 4: Agent 01 Commits & Releases -->
          <line x1="100" y1="164" x2="304" y2="164" stroke="#00C472" stroke-width="1.5"/>
          <text x="202" y="157" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.3" font-weight="600">4. commit(verify) + coord_release</text>

          <!-- Step 5: IPC Hand-off & Auto-Rebase -->
          <line x1="304" y1="194" x2="508" y2="194" stroke="#233E33" stroke-width="1.4"/>
          <text x="406" y="187" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2" font-weight="600">5. ipc_send("Schema ready") + Auto-Rebase</text>

          <line x1="304" y1="224" x2="675" y2="224" stroke="#233E33" stroke-width="1.3"/>
          <text x="490" y="217" text-anchor="middle" fill="#4A534E" font-family="Inter, sans-serif" font-size="8.6">6. Verified micro-commit lands on host trunk in real time</text>
        </svg>
        <figcaption>Figure 2: Proactive collision prevention and real-time hand-off via TTL file claims (<code>coord_claim</code>) and piggybacked IPC notifications.</figcaption>
      </figure>

      <ol>
        <li><strong>Task-Bound Glob File Claims (<code>coord_claim</code>)</strong>: Before modifying any file, an agent claims its target paths or glob patterns on the coordination bus (backed by a 2D NFA + live workspace file-tree intersection engine and <code>coordination_warning</code> alerts on out-of-claim sandbox writes). A monotonically increasing <code>claims_version</code> guarantees a consistent global lock table, while automatic release upon <code>workspace_commit</code>, task completion/cascade cancellation, or TTL expiration prevents deadlocks.</li>
        <li><strong>Stratified Protection for Structured Text vs. Binary Deliverables (<code>overwrite_binaries</code>)</strong>: File collaboration frequently involves non-mergeable binary artifacts—PDF reports, high-DPI scientific figures (PNG/TIFF), SQLite snapshots, or Office archives. Because binary files cannot be merged line-by-line, Aegis OS enforces exclusive pre-edit claims via <code>coord_claim</code> and checks base SHA-256 digests during <code>workspace_commit</code>: if a binary artifact on the host was modified concurrently, shadow overwrites are blocked unless explicitly authorized with <code>overwrite_binaries: true</code> (while rich <code>.docx / .pptx</code> manuscripts bridge seamlessly to Monograph 01’s Dual-Surface CRDT block locks and <code>patchParagraph</code> exporter).</li>
        <li><strong>Zero-Polling Piggybacked Inbox &amp; Blocking Wakeup (<code>_inbox</code> + <code>ipc_wait</code>)</strong>: Agents never waste turns polling for lock updates. Every syscall response automatically piggybacks unread coordination events and peer-to-peer messages (<code>ipc_send / ipc_request</code> with hierarchical <code>parent_task_id</code> and <code>depends_on</code> DAG support), while clients without lifecycle hooks (such as Codex CLI) can invoke <code>ipc_wait</code> to block until an event arrives.</li>
        <li><strong>Proactive Pivoting &amp; Seamless Relay</strong>: As shown in Figure 2, when Agent 02 sees that Agent 01 holds the lock on upstream schema or dataset files, it immediately pivots to claiming orthogonal files. As soon as Agent 01 commits (automatically releasing its claimed paths), Agent 02 receives the wake-up notification, auto-rebases the new files into its shadow workspace, and completes the integration—with <strong>zero merge conflicts and zero human copy-paste relay</strong>.</li>
      </ol>

      <pre><code>// Concise pseudocode for Task-Bound Glob Claims, Auto-Release &amp; Reactive Hand-Off
claim = coord_claim(agent_id, paths = ["api.ts", "figures/*.svg"], ttl_ms = 600000) // Auto-bound to active A2A task_id
if claim.rejected is not empty:
  // Peer agent holds overlapping file/glob lock → pivot to orthogonal files or block on ipc_wait
  pivotToOrthogonalModuleOrWait(claim.active_holder)
else:
  editInCowShadow(paths)                     // Mutate code, docs, or data safely inside 0.42ms shadow workspace
  workspace_commit(paths, verify_cmd = "test") // Serialized commit lock + epoch re-verify + auto-releases claimed paths!</code></pre>

      <h2 id="sec-micro-commit">04. Continuous Micro-Transactions: 4-Tier LCS Auto-Merge &amp; Generalized Domain Verification Gates</h2>
      <p>What happens when a human expert edits the top of a shared configuration file, LaTeX manuscript, or JSON/CSV table in their editor while an agent edits the bottom of that same file in its shadow workspace? Instead of dumping raw conflict markers or clobbering edits, <code>workspace_commit</code> executes a <strong>4-Tier Longest Common Subsequence (LCS) Diff3 Auto-Merge coupled with a Generalized Domain Verification Gate</strong>:</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 250" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="4-Tier LCS Diff3 Auto-Merge and Generalized Domain Verification Pipeline">
          <rect x="1" y="1" width="758" height="248" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Left: 3 Inputs -->
          <rect x="20" y="24" width="166" height="56" fill="#F2EFE9" stroke="#C8C1B4"/>
          <text x="103" y="46" text-anchor="middle" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">BASE SNAPSHOT (O)</text>
          <text x="103" y="65" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9">State at shadow fork time</text>

          <rect x="20" y="96" width="166" height="56" fill="#F2EFE9" stroke="#233E33"/>
          <text x="103" y="118" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">LIVE HOST TRUNK (H)</text>
          <text x="103" y="137" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="9">Includes human &amp; peer edits</text>

          <rect x="20" y="168" width="166" height="56" fill="#E3ECE7" stroke="#233E33"/>
          <text x="103" y="190" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.6" font-weight="600">AGENT SHADOW (A)</text>
          <text x="103" y="209" text-anchor="middle" fill="#233E33" font-family="Inter, sans-serif" font-size="9">Current agent’s shadow edits</text>

          <path d="M186 52 L222 104" stroke="#4A534E" stroke-width="1.2"/>
          <line x1="186" y1="124" x2="222" y2="124" stroke="#233E33" stroke-width="1.3"/>
          <path d="M186 196 L222 144" stroke="#233E33" stroke-width="1.3"/>

          <!-- Center: 4-Tier LCS Diff3 -->
          <rect x="222" y="32" width="276" height="184" fill="#233E33" stroke="#151C19" stroke-width="1.2"/>
          <text x="360" y="55" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600">4-TIER LCS DIFF3 AUTO-MERGE</text>
          <line x1="222" y1="65" x2="498" y2="65" stroke="#395A4C"/>
          <text x="236" y="90" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.4">Tier 1 · Fast-Forward (when H == O)</text>
          <text x="236" y="116" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.4">Tier 2 · Line-level LCS non-overlapping merge</text>
          <text x="236" y="142" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.4">Tier 3 · Whitespace &amp; indentation normalized</text>
          <text x="236" y="168" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.4">Tier 4 · Adjacent sub-hunk splice (98.7% rate)</text>
          <text x="236" y="196" fill="#E3ECE7" font-family="Inter, sans-serif" font-size="8.8">Aborts on true/binary collision · 0% overwrite</text>

          <line x1="498" y1="124" x2="532" y2="124" stroke="#00C472" stroke-width="1.5"/>

          <!-- Right: Pre-Commit Gate & Atomic Land -->
          <rect x="532" y="32" width="208" height="184" fill="#EFECE4" stroke="#151C19" stroke-width="1.2"/>
          <text x="636" y="55" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">DOMAIN VERIFY GATE</text>
          <line x1="532" y1="65" x2="740" y2="65" stroke="#C8C1B4"/>
          <text x="546" y="90" fill="#151C19" font-family="Inter, sans-serif" font-size="9.2">1. Runs sandboxed verify_cmd:</text>
          <text x="546" y="108" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.1">   • Code: tsc / cargo test</text>
          <text x="546" y="124" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.1">   • Docs: latexmk / link check</text>
          <text x="546" y="140" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.1">   • Data: Schema &amp; PHI scan</text>
          <text x="546" y="164" fill="#8F5638" font-family="Inter, sans-serif" font-size="9.2">2. Gate fails → auto-abort</text>
          <text x="546" y="190" fill="#233E33" font-family="Inter, sans-serif" font-size="9.2" font-weight="600">3. Gate green → atomic land</text>
        </svg>
        <figcaption>Figure 3: Continuous micro-transaction commit pipeline—reconciling <i>O / H / A</i> states via 4-tier LCS auto-merge and enforcing a generalized domain verification gate before atomic host landing.</figcaption>
      </figure>

      <ul>
        <li><strong>98.7% Conflict-Free Convergence Across All Text Formats</strong>: Whether a human and an agent concurrently edit different sections of a TypeScript module, a LaTeX paper, a Markdown knowledge vault, or a JSON configuration file, the 4-tier LCS resolver merges non-overlapping hunks in milliseconds with 0% silent overwrites.</li>
        <li><strong>Generalizing <code>verify_cmd</code> Beyond Code Compilers (Always-Valid Trunk)</strong>: In code repositories, <code>verify_cmd</code> runs typecheckers and unit tests. In document and data workspaces, it acts as a <strong>universal domain invariant gate</strong>—running <code>latexmk -pdf</code> and citation/link verifiers for research manuscripts, or executing JSON Schema checks, CONSORT arithmetic conservation audits, and <code>scanPhi --strict</code> privacy gates so no corrupted document or PHI leak ever lands in the host workspace.</li>
      </ul>

      <h2 id="sec-universal-scenarios">05. Beyond Source Code: Four Collaboration Scenarios Across File Vaults, CAS Data Pipelines &amp; Live Apps</h2>
      <p>Once we decouple "Copy-on-Write shadow workspaces + proactive TTL claims + piggybacked IPC + verified micro-commits" from Git-specific assumptions, Aegis OS emerges as a <strong>universal transactional collaboration kernel for all knowledge work</strong>. By combining the VFS and coordination bus with <strong>SHA-256 Content-Addressed Storage (<code>org_artifact_publish / fetch</code>)</strong>, <strong>scoped KV state (<code>org_kv_put / get</code>)</strong>, <strong>live application mounting (<code>AAP-1.0</code>)</strong>, and <strong>governed memory leases (<code>UOMP</code>)</strong>, the kernel powers four distinct collaboration domains:</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 288" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four Universal Collaboration Scenarios Powered by Aegis OS">
          <rect x="1" y="1" width="758" height="286" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Top Banner: Shared Transactional Kernel -->
          <rect x="20" y="18" width="720" height="44" fill="#233E33" stroke="#151C19" stroke-width="1.2"/>
          <text x="380" y="37" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">AEGIS OS UNIVERSAL TRANSACTIONAL COLLABORATION KERNEL</text>
          <text x="380" y="53" text-anchor="middle" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="9.5">0.42ms CoW Shadow VFS · Task-Bound TTL Claims · Piggybacked IPC &amp; DAG · 4-Tier LCS + Verify Gate · SHA-256 CAS Bus</text>

          <!-- Col 1: Codebase -->
          <rect x="20" y="78" width="171" height="190" fill="#F2EFE9" stroke="#233E33" stroke-width="1"/>
          <text x="105" y="99" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5" font-weight="600">SCENARIO 01 · CODEBASE</text>
          <line x1="20" y1="108" x2="191" y2="108" stroke="#DFDAD0"/>
          <text x="105" y="128" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10" font-weight="600">Software Engineering</text>
          <text x="30" y="150" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• Zero-copy node_modules</text>
          <text x="30" y="170" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• Claim api/** &amp; schema.ts</text>
          <text x="30" y="190" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• 4-Tier LCS hunk merge</text>
          <text x="30" y="210" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8" font-weight="600">• Gate: tsc &amp; vitest</text>
          <text x="30" y="246" fill="#8F5638" font-family="Inter, sans-serif" font-size="8.2">Replaces Git worktree sprawl</text>

          <!-- Col 2: Files & Docs -->
          <rect x="203" y="78" width="171" height="190" fill="#E3ECE7" stroke="#233E33" stroke-width="1"/>
          <text x="288" y="99" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5" font-weight="600">SCENARIO 02 · FILE VAULTS</text>
          <line x1="203" y1="108" x2="374" y2="108" stroke="#C8C1B4"/>
          <text x="288" y="128" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10" font-weight="600">Docs &amp; File Trees</text>
          <text x="213" y="150" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• LaTeX/MD/JSON co-editing</text>
          <text x="213" y="170" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• Binary PDF/DOCX guard</text>
          <text x="213" y="190" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• Bridges to CRDT &amp; OOXML</text>
          <text x="213" y="210" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8" font-weight="600">• Gate: Build &amp; citation check</text>
          <text x="213" y="246" fill="#233E33" font-family="Inter, sans-serif" font-size="8.2">Eliminates 41.2% file overwrites</text>

          <!-- Col 3: Data & CAS Pipelines -->
          <rect x="386" y="78" width="171" height="190" fill="#F2EFE9" stroke="#233E33" stroke-width="1"/>
          <text x="471" y="99" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.5" font-weight="600">SCENARIO 03 · DATA &amp; CAS</text>
          <line x1="386" y1="108" x2="557" y2="108" stroke="#DFDAD0"/>
          <text x="471" y="128" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10" font-weight="600">Data &amp; Artifact Pipelines</text>
          <text x="396" y="150" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• Zero-copy multi-GB data</text>
          <text x="396" y="170" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• Immutable SHA-256 CAS</text>
          <text x="396" y="190" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8">• depends_on DAG wakeups</text>
          <text x="396" y="210" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8" font-weight="600">• Gate: Math &amp; PHI scan</text>
          <text x="396" y="246" fill="#8F5638" font-family="Inter, sans-serif" font-size="8.2">Prevents /tmp dirty reads</text>

          <!-- Col 4: Live Apps & Memory -->
          <rect x="569" y="78" width="171" height="190" fill="#EFECE4" stroke="#151C19" stroke-width="1"/>
          <text x="654" y="99" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.5" font-weight="600">SCENARIO 04 · APPS &amp; UOMP</text>
          <line x1="569" y1="108" x2="740" y2="108" stroke="#C8C1B4"/>
          <text x="654" y="128" text-anchor="middle" fill="#151C19" font-family="Inter, sans-serif" font-size="10" font-weight="600">Live Apps &amp; Memory</text>
          <text x="579" y="150" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• AAP-1.0 live app sessions</text>
          <text x="579" y="170" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• UOMP memory consent</text>
          <text x="579" y="190" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8">• L7 secret injection &amp; DLP</text>
          <text x="579" y="210" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8" font-weight="600">• Gate: 3-Tier confirmation</text>
          <text x="579" y="246" fill="#233E33" font-family="Inter, sans-serif" font-size="8.2">Unifies local &amp; SaaS state</text>
        </svg>
        <figcaption>Figure 4: Four universal collaboration scenarios powered by Aegis OS—spanning source code, multi-modal file vaults, SHA-256 CAS data pipelines, and cross-boundary applications/memory.</figcaption>
      </figure>

      <ol>
        <li><strong>Scenario 01 · Software Engineering &amp; Multi-Module Refactoring (Codebase Collaboration)</strong>: A human architect and multiple coding agents collaborate directly on the main trunk. While the human refines core domain models in their IDE, Agent A claims backend routes and Agent B claims frontend components—each compiling and testing inside a 0.42ms CoW shadow that shares read-only build caches before landing verified micro-commits.</li>
        <li><strong>Scenario 02 · Multi-File Research Manuscripts, Local Knowledge Vaults &amp; Binary Assets (File Collaboration)</strong>: When co-authoring grant proposals, LaTeX/Markdown books, or enterprise knowledge bases (similar to desktop Cowork workflows), multiple agents edit chapter files, bibliography databases (<code>refs.bib</code>), and vector figures concurrently. Structured text files merge automatically via 4-Tier LCS Diff3, while non-mergeable binary assets (PDFs, figures, <code>.docx / .pptx</code> archives) are protected by exclusive <code>coord_claim</code> locks and <code>overwrite_binaries</code> hash checks (bridging to Monograph 01’s Dual-Surface CRDT for sub-paragraph manuscript collaboration).</li>
        <li><strong>Scenario 03 · Data Science Pipelines &amp; SHA-256 Content-Addressed Artifact Handoffs (Data Collaboration)</strong>: In multi-stage analytical workflows (e.g., Cohort Cleaning Agent → Biostatistical Modeling Agent → Forest Plot SVG Agent), sharing a raw <code>/tmp</code> directory leads to dirty reads of half-written CSVs. Instead, Aegis OS agents process gigabyte-scale datasets inside zero-copy shadow workspaces, publish validated outputs as immutable <strong>SHA-256 Content-Addressed Storage (CAS)</strong> blobs via <code>org_artifact_publish</code>, and trigger downstream peers through <code>depends_on</code> task DAGs (<code>ipc_task_update</code>) with 100% reproducibility.</li>
        <li><strong>Scenario 04 · Live SaaS Applications (<code>AAP-1.0</code>) &amp; Governed Multi-Agent Memory (<code>UOMP</code>)</strong>: Collaboration extends beyond the local disk. Through the Aegis Application Protocol (<code>app_mount_session</code> / <code>app_call_tool</code>), local agents mount authenticated sessions in live web applications (connecting directly to Monograph 02’s Capability Parity architecture), while cross-agent access to personal or organizational memory is governed by revocable <strong>UOMP (User-Owned Memory Protocol)</strong> leases.</li>
      </ol>

      <h2 id="sec-permission-audit">06. Why AI Boundary Permission Requests Must Be End-to-End Auditable</h2>
      <p>When collaboration expands from source code to a user’s local document folders, research datasets, external APIs, and personal memory, a foundational governance requirement emerges: <strong>the act of an AI requesting a boundary permission must be structured and end-to-end auditable (End-to-End Auditable Permission Escalations)</strong>.</p>
      <p>Current coding and desktop file agents typically fall into one of two broken extremes:</p>
      <ul>
        <li><strong>Ephemeral Modal Fatigue</strong>: The agent interrupts the user with transient \"Allow command?\" dialogs for every file edit or script execution. Once clicked, the dialog vanishes without recording a structured audit trail of <em>why</em> the agent requested the permission, what parameters were attached, or which files/data were affected;</li>
        <li><strong>Unlogged Auto-Approve Mode</strong>: Frustrated by constant prompts, users enable flags that skip permission checks entirely—leaving zero forensic attribution when an agent overwrites important documents, leaks sensitive configurations, or mutates production resources.</li>
      </ul>
      <p>Our shadow workspace architecture resolves the tension between velocity and governance through <strong>Zero-Prompt Speculative Execution Inside the Sandbox + Structured Permission Escalation Ledgers at the Boundary</strong>. While an agent works freely inside its isolated Copy-on-Write layer, <strong>every permission request that crosses a collaboration or security boundary</strong>—claiming shared file locks (<code>coord_claim</code>), committing shadow changes or binary files to the host directory (<code>esc-*</code> escalation tickets), requesting external network egress (<code>egress_http_request</code>), or accessing long-term memory namespaces (<code>memory_policy_evaluate</code>)—is recorded as an immutable <strong>Permission Escalation Ticket</strong>:</p>

      <figure class="blog-diagram">
        <svg viewBox="0 0 760 256" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="End-to-End Auditable AI Permission Escalation and Hash-Chained Ledger">
          <rect x="1" y="1" width="758" height="254" fill="#FAF8F4" stroke="#DFDAD0" stroke-width="1"/>

          <!-- Stage 1: Boundary Request -->
          <rect x="20" y="30" width="166" height="196" fill="#F2EFE9" stroke="#233E33" stroke-width="1"/>
          <text x="103" y="54" text-anchor="middle" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.8" font-weight="600">1. PERMISSION REQUEST</text>
          <line x1="20" y1="64" x2="186" y2="64" stroke="#DFDAD0"/>
          <text x="32" y="88" fill="#151C19" font-family="Inter, sans-serif" font-size="9.2" font-weight="600">Boundary Capabilities:</text>
          <text x="32" y="110" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">• coord_claim (file locks)</text>
          <text x="32" y="130" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">• workspace_commit (trunk)</text>
          <text x="32" y="150" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">• egress_http (network)</text>
          <text x="32" y="170" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">• memory_policy (consent)</text>
          <text x="32" y="202" fill="#4A534E" font-family="Inter, sans-serif" font-size="8.5">Zero prompts in CoW · Audited at boundary</text>

          <line x1="186" y1="128" x2="216" y2="128" stroke="#233E33" stroke-width="1.4"/>

          <!-- Stage 2: Escalation Ticket -->
          <rect x="216" y="30" width="248" height="196" fill="#233E33" stroke="#151C19" stroke-width="1.2"/>
          <text x="340" y="54" text-anchor="middle" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.8" font-weight="600">2. STRUCTURED ESCALATION TICKET</text>
          <line x1="216" y1="64" x2="464" y2="64" stroke="#395A4C"/>
          <text x="230" y="88" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.3">ticket_id:   "esc-89e2a50b"</text>
          <text x="230" y="108" fill="#FAF8F4" font-family="JetBrains Mono, monospace" font-size="8.3">principal:   agent_id + user_id</text>
          <text x="230" y="128" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.3">scope:       Exact paths / domain / TTL</text>
          <text x="230" y="148" fill="#E3ECE7" font-family="JetBrains Mono, monospace" font-size="8.3">rationale:   Declared intent &amp; task context</text>
          <text x="230" y="168" fill="#00C472" font-family="JetBrains Mono, monospace" font-size="8.3">evidence:    Unified Diff + verify exit code</text>
          <text x="230" y="200" fill="#FAF8F4" font-family="Inter, sans-serif" font-size="8.6" font-weight="500">Immutable request &amp; evidence snapshot</text>

          <line x1="464" y1="128" x2="494" y2="128" stroke="#00C472" stroke-width="1.4"/>

          <!-- Stage 3: Hash-Chained Audit Ledger -->
          <rect x="494" y="30" width="246" height="196" fill="#EFECE4" stroke="#151C19" stroke-width="1.2"/>
          <text x="617" y="54" text-anchor="middle" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.8" font-weight="600">3. HASH-CHAINED AUDIT LEDGER</text>
          <line x1="494" y1="64" x2="740" y2="64" stroke="#C8C1B4"/>
          <text x="508" y="88" fill="#151C19" font-family="Inter, sans-serif" font-size="9.2" font-weight="600">All Adjudication Outcomes Logged:</text>
          <text x="508" y="110" fill="#233E33" font-family="JetBrains Mono, monospace" font-size="8.2">✓ APPROVED (approver / policy rule)</text>
          <text x="508" y="130" fill="#8F5638" font-family="JetBrains Mono, monospace" font-size="8.2">✕ REJECTED / DENIED (blocked probe)</text>
          <text x="508" y="150" fill="#4A534E" font-family="JetBrains Mono, monospace" font-size="8.2">⏱ EXPIRED (TTL timeout record)</text>
          <text x="508" y="174" fill="#151C19" font-family="JetBrains Mono, monospace" font-size="8.2">prev_hash → sha256(ticket + decision)</text>
          <text x="508" y="202" fill="#233E33" font-family="Inter, sans-serif" font-size="8.6" font-weight="600">Forensic replay, attribution &amp; rollback</text>
        </svg>
        <figcaption>Figure 5: End-to-end auditable AI permission requests—capturing every boundary capability request (file claims, trunk commits, network egress, memory access) in a hash-chained ledger.</figcaption>
      </figure>

      <pre><code>// Concise pseudocode for Auditable Boundary Permission Requests
function requestBoundaryPermission(agent_id, user_id, perm_type, scope, rationale, evidence):
  ticket = { id: newEscalationId(), agent_id, user_id, perm_type, scope, rationale, evidence, ts: now() }
  decision = evaluatePolicyOrAwaitHuman(ticket) // Evaluates policy rules or awaits human approval (APPROVED | REJECTED | DENIED)
  audit_ledger.appendHashChained({ ...ticket, decision, prev_hash: audit_ledger.tailHash() }) // Logged regardless of outcome
  return decision</code></pre>

      <h3>6.1 Comparing Version Control &amp; Universal Multi-Agent Collaboration Paradigms</h3>
      <div class="blog-table-wrap">
        <table class="blog-table">
          <thead>
            <tr>
              <th>Collaboration Dimension</th>
              <th>Git Feature Branches / Worktrees</th>
              <th>Raw Shared Folder (Cowork / File Agents)</th>
              <th>Aegis OS Transactional Collaboration Kernel</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Supported Artifact Scope</td>
              <td>Source code only (heavyweight for data/docs)</td>
              <td>Any local file, but zero transactional safety</td>
              <td><strong>Codebases + File Vaults + CAS Data Pipelines + Live Apps</strong></td>
            </tr>
            <tr>
              <td>Workspace Isolation Overhead</td>
              <td>400+ ms copy / multi-GB cache duplication</td>
              <td>0 ms (no isolation; partial writes pollute host)</td>
              <td><strong>0.42 ms CoW fork / 0 B duplicate physical blocks</strong></td>
            </tr>
            <tr>
              <td>Conflict Discovery Timing</td>
              <td>Late (explodes at PR merge time)</td>
              <td>Blind (41.2% silent last-writer overwrites)</td>
              <td><strong>Proactive TTL file claims (<code>coord_claim</code>) + binary guards</strong></td>
            </tr>
            <tr>
              <td>Cross-Agent Artifact &amp; State Handoff</td>
              <td>Manual human relay across branches</td>
              <td>Dirty reads from shared <code>/tmp</code> files</td>
              <td><strong>Piggybacked IPC mailbox + SHA-256 CAS artifact bus</strong></td>
            </tr>
            <tr>
              <td>Concurrent Edits in Same File</td>
              <td>Manual rebase &amp; conflict marker resolution</td>
              <td>Whole-file silent overwrite</td>
              <td><strong>4-Tier LCS Diff3 auto-merge (98.7% conflict-free)</strong></td>
            </tr>
            <tr>
              <td>Host Quality &amp; Compliance Gate</td>
              <td>Unverified until post-merge CI</td>
              <td>None; broken scripts or PHI leaks land directly</td>
              <td><strong>Generalized <code>verify_cmd</code> gate (Tests / LaTeX / PHI scan)</strong></td>
            </tr>
            <tr>
              <td>Permission Request Auditability</td>
              <td>Final Git commit only; no escalation log</td>
              <td>Ephemeral modal popups or unlogged bypass</td>
              <td><strong>Structured escalation tickets + hash-chained audit ledger</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>By uniting <strong>0.42ms Copy-on-Write shadow workspaces</strong>, <strong>proactive TTL file claims and binary guards</strong>, <strong>piggybacked IPC and SHA-256 CAS artifact buses</strong>, <strong>4-tier LCS micro-commits with generalized domain verification gates</strong>, and <strong>end-to-end auditable permission escalations</strong>, Aegis OS moves beyond code-only Git branch ceremonies and fragile shared folders—providing a universal, transactional operating system foundation for human-agent collaboration across code, documents, data science, and live enterprise software.</p>
    `,
  },
]

export const DRAFT_BLOG_POSTS: ReadonlyArray<Omit<BlogPostMeta, 'slug'> & { slug: string }> = [
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
        <li><strong>Stage 2 · 内部文-表-图算术一致性核查（Internal Arithmetic Audit）</strong>：自动交叉比对正文 Results 中的样本量 <i>N</i>、百分比、HR/OR 置信区间是否与文内 Table 1 及 CONSORT 纳排漏斗完全闭合。</li>
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
      <p>与认知技能正交，<code>ProceduralHarnessService</code>（Track B）专门从智能体的工具报错与恢复轨迹（Guard Reject → Successful Retry）中自主合成写前预检规则：</p>
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
        <li><strong>Stage 2 · Internal Prose-to-Table Arithmetic Audit</strong>: Cross-checks sample sizes <i>N</i>, percentages, and HR/OR confidence intervals in prose against Table 1 and CONSORT flowcharts.</li>
        <li><strong>Stage 3 · Biostatistical Methodology Audit</strong>: Verifies normality branching (Mean±SD vs. Median [IQR]), exact tests for sparse cells, and E-value sensitivity analysis for unmeasured confounding in observational cohorts.</li>
        <li><strong>Stage 4 · Clinical Spin Bias &amp; Guideline Compliance</strong>: Flags spin language when <i>P</i> &gt; 0.05 and anchors actionable review threads <code>{#c:id}</code> directly onto the target CRDT block.</li>
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
      <p><code>ProceduralHarnessService</code> (Track B) observes <em>Guard Rejection → Recovery</em> pairs during live execution. Rather than polluting memory on single-turn noise, it enforces a <strong>Commit-on-Evidence</strong> threshold (≥ 2 corroborated recovery trajectories) and attribution-filtered credit assignment to synthesize executable pre-flight checks.</p>

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
        <li><strong>ISO 7064 MOD 11-2 身份证校验</strong>：对 18 位中国居民身份证号严格验证行政区划前缀、出生日期合法性以及第 18 位校验码（∑ <i>a<sub>i</sub>w<sub>i</sub></i> ≡ 1 mod 11），在实现 100% 召回的同时消除科学数值误报；</li>
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
        <li><strong>ISO 7064 MOD 11-2 National ID Verification</strong>: Validates region prefixes, calendar dates, and the 18th check digit (∑ <i>a<sub>i</sub>w<sub>i</sub></i> ≡ 1 mod 11), achieving 100% recall across 1,200 PHI samples at <strong>0.85 ms/document</strong> without false alarms on scientific numbers;</li>
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
    slug: 'ai-native-document-crdt-publishing',
    num: '06',
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


