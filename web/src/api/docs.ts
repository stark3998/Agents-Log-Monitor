import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface DocHeading { depth: number; text: string; slug: string }
export interface DocRef { id: string; title: string }

export interface DocMeta {
  id: string;
  path: string;
  title: string;
  section: string;
  description: string;
  headings: DocHeading[];
  words: number;
  updatedAt: string;
}

export interface DocDetail extends DocMeta {
  content: string;
  links: DocRef[];
  backlinks: DocRef[];
  prev?: DocRef;
  next?: DocRef;
}

export interface DocSection { title: string; docs: DocMeta[] }
export interface DocsIndex { sections: DocSection[]; count: number }

export interface DocSearchHit {
  id: string;
  path: string;
  title: string;
  section: string;
  heading?: string;
  anchor?: string;
  snippet: string;
  terms: string[];
  score: number;
}

export const useDocsIndex = () =>
  useQuery({ queryKey: ['docs'], queryFn: () => api<DocsIndex>('docs'), staleTime: 60_000 });

export const useDoc = (id: string | null) =>
  useQuery({ queryKey: ['doc', id], queryFn: () => api<DocDetail>('docs/page', { id: id! }), enabled: !!id, staleTime: 60_000 });

export const useDocSearch = (q: string) =>
  useQuery({
    queryKey: ['docs-search', q],
    queryFn: () => api<{ query: string; hits: DocSearchHit[] }>('docs/search', { q, limit: '30' }),
    enabled: !!q.trim(),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
