// pdfmake 0.3 ships no types; this declares only what targets/pdf.ts uses.
declare module 'pdfmake' {
  interface FontFiles {
    normal: string
    bold: string
    italics: string
    bolditalics: string
  }
  interface OutputDocument {
    getBuffer(): Promise<Uint8Array>
  }
  const pdfmake: {
    virtualfs: { writeFileSync(name: string, content: Uint8Array): void }
    setFonts(fonts: Record<string, FontFiles>): void
    setUrlAccessPolicy(policy: (url: string) => boolean): void
    setLocalAccessPolicy(policy: (path: string) => boolean): void
    createPdf(definition: object): OutputDocument
  }
  export default pdfmake
}
