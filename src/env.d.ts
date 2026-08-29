/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
	readonly PUBLIC_WEBHOOK_URL: string;
	readonly PUBLIC_CHECKOUT_WEBHOOK_URL: string;
	readonly PUBLIC_ADMIN_WEBHOOK_URL: string;
	readonly PUBLIC_VERIFY_WEBHOOK_URL: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
