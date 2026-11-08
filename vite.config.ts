import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // The agent workspace IS this project root, so agent runs write scratch
  // here: .rapa/ (working memory, evicted outputs, worktree-isolated run
  // checkouts — which contain full project copies including index.html),
  // dev.db WAL files, logs. Without these ignores, every agent file-write
  // forced a Vite full page reload of the app the user is looking at.
  // Real source edits in src/ still hot-reload normally.
  server: {
    watch: {
      ignored: ['**/.rapa/**', '**/server/prisma/dev.db*', '**/*.log'],
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
  build: {
    outDir: "web-dist",
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router'],
          'vendor-radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-switch',
            '@radix-ui/react-select',
          ],
          'vendor-markdown': ['react-markdown', 'remark-gfm', 'remark-math', 'rehype-katex'],
          'vendor-syntax': ['react-syntax-highlighter'],
          'vendor-motion': ['motion'],
        },
      },
    },
  }
})
