export interface Article {
  pmid: string | null
  doi: string | null
  title: string
  authors: string[]
  journal: string
  year: string
  volume?: string
  issue?: string
  pages?: string
  abstract?: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
