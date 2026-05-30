import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// The daemon's JSON API (src/server.ts). Proxy /api → it in dev so the SPA can
// use same-origin relative URLs.
const API = process.env.GAVL_API ?? "http://127.0.0.1:6440";

export default defineConfig({
	plugins: [svelte()],
	server: {
		port: 5180,
		proxy: { "/api": { target: API, changeOrigin: true } },
	},
});
