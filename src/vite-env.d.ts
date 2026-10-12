/// <reference types="vite/client" />

interface Window {
  meshcraft?: {
    saveStl(name: string, data: ArrayBuffer): Promise<boolean>;
  };
}
