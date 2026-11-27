import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Порт фиксирован: его же открывает окно Tauri в режиме разработки.
export default defineConfig({
  plugins: [preact()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022' },
});
