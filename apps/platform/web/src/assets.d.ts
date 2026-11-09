declare module '*.jpg' {
  const url: string
  export default url
}

// vite 的 ?url 导入（pdf.js 的 worker 随前端构建自托管）
declare module '*?url' {
  const url: string
  export default url
}
