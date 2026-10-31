/** Minimal ambient types for pdfjs-dist's legacy ESM build (it ships no d.ts at that path). */
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export const version: string;

  export interface TextItem {
    str: string;
    /** [a, b, c, d, e, f] — e/f are the x/y translation. */
    transform: number[];
    width?: number;
    height?: number;
  }

  export interface PDFPageProxy {
    getTextContent(): Promise<{ items: unknown[] }>;
    cleanup(): void;
  }

  export interface PDFDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PDFPageProxy>;
    /** Bookmark tree, or null when the file has none. */
    getOutline(): Promise<unknown[] | null>;
    /** Resolve a named destination to its explicit/positional destination. */
    getDestination(name: string): Promise<unknown>;
    /** 0-based page index of a page reference. */
    getPageIndex(ref: unknown): Promise<number>;
  }

  export interface PDFDocumentLoadingTask {
    promise: Promise<PDFDocumentProxy>;
    destroy(): Promise<void>;
  }

  export function getDocument(src: unknown): PDFDocumentLoadingTask;
  export const GlobalWorkerOptions: { workerSrc: string };
}
