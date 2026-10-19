import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const paperDir = join(__dirname, '..')
const distDir = join(paperDir, 'arxiv_dist')

/**
 * Strips LaTeX comments (% ...) while preserving escaped \% characters
 * and verbatim/lstlisting blocks, then appends the 4-pass arXiv typeout directive.
 */
function sanitizeLatexForArxiv(src: string): string {
  const lines = src.split('\n')
  const cleaned: string[] = []
  let inListing = false

  for (const line of lines) {
    if (line.includes('\\begin{lstlisting}')) inListing = true
    if (line.includes('\\end{lstlisting}')) {
      inListing = false
      cleaned.push(line)
      continue
    }

    if (inListing) {
      cleaned.push(line)
      continue
    }

    // If the entire trimmed line is a comment, drop it completely
    if (/^\s*%/.test(line)) {
      continue
    }

    // Strip unescaped inline % comments
    let out = ''
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
        break
      }
      out += line[i]
    }
    cleaned.push(out.trimEnd())
  }

  let result = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
  const fourPassDirective = '\\typeout{get arXiv to do 4 passes: Label(s) may have changed. Rerun}\n'
  if (!result.includes(fourPassDirective.trim())) {
    result += fourPassDirective
  }
  return result
}

// 1. Recreate clean flat distribution directory `paper/arxiv_dist/`
rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

// 2. Read `paper/main.tex`, strip all LaTeX comments, append 4-pass typeout after \end{document}
const rawTex = readFileSync(join(paperDir, 'main.tex'), 'utf8')
const sanitizedTex = sanitizeLatexForArxiv(rawTex)
writeFileSync(join(distDir, 'main.tex'), sanitizedTex, 'utf8')

// 3. Package flat tarballs (`paper/ax.tar` and `paper/heurion2_arxiv.tar.gz`) with zero hidden files
execSync('COPYFILE_DISABLE=1 tar -cvf ../ax.tar main.tex', { cwd: distDir })
execSync('COPYFILE_DISABLE=1 tar -czvf ../heurion2_arxiv.tar.gz main.tex', { cwd: distDir })

console.log('Successfully prepared clean arXiv source packages: paper/ax.tar and paper/heurion2_arxiv.tar.gz')
