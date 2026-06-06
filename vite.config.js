import { defineConfig } from 'vite'

export default defineConfig({
    server: {
        proxy: {
            '/upload': 'http://localhost:9872',
            '/img': 'http://localhost:9872',
        },
    },
})
