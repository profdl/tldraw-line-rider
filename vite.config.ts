import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @tonejs/piano's MIDI input imports Node's built-in `events`, which Vite
      // externalizes for the browser (leaving EventEmitter undefined and crashing
      // the module on import). Alias it to the `events` browser polyfill so the
      // package loads even though we never use its MIDI features.
      events: 'events',
    },
  },
})
