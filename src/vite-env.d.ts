/// <reference types="vite/client" />

declare module '*.py?url' {
  const src: string;
  export default src;
}
