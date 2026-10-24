// La cuenta conectada vive solo en este navegador. El token nunca se guarda
// en ningún servidor: sessionStorage (se borra al cerrar la pestaña) o, si el
// usuario lo pide, localStorage.

import type { Account, AccountStore } from '../src/broker/routes.ts'
import { QvaPayClient, QvaPayError } from '../src/qvapay/client.ts'

export const TOKEN_KEY = 'tp.token'
const SID = 'browser'

export interface TokenStorage {
	session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
	local: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

export class BrowserAccounts implements AccountStore {
	private readonly storage: TokenStorage
	private readonly baseUrl: string
	private acc: Account | null = null
	private loading: Promise<Account | null> | null = null

	constructor(opts: { storage: TokenStorage; baseUrl: string }) {
		this.storage = opts.storage
		this.baseUrl = opts.baseUrl
	}

	newSid() {
		return SID
	}

	// Valida el token contra QvaPay antes de guardarlo
	async connect(_sid: string, token: string, opts: { remember?: boolean } = {}): Promise<Account> {
		const client = new QvaPayClient({ token, dryRun: false, baseUrl: this.baseUrl })
		const me = await client.me()
		this.clear()
		safe(() => (opts.remember ? this.storage.local : this.storage.session).setItem(TOKEN_KEY, token))
		this.acc = { sid: SID, me, client }
		return this.acc
	}

	async get(): Promise<Account | null> {
		if (this.acc) return this.acc
		// Varias llamadas a la vez comparten la misma carga
		this.loading ??= this.load().finally(() => (this.loading = null))
		return this.loading
	}

	// La cuenta con la que se lee el libro: solo la del propio usuario
	reader() {
		return this.get().catch(() => null)
	}

	async disconnect() {
		this.acc = null
		this.clear()
	}

	private async load(): Promise<Account | null> {
		const token = safe(() => this.storage.session.getItem(TOKEN_KEY) ?? this.storage.local.getItem(TOKEN_KEY))
		if (!token) return null
		const client = new QvaPayClient({ token, dryRun: false, baseUrl: this.baseUrl })
		try {
			this.acc = { sid: SID, me: await client.me(), client }
			return this.acc
		} catch (err) {
			// Token revocado o caducado: se borra de este navegador
			if (err instanceof QvaPayError && err.status === 401) this.clear()
			throw err
		}
	}

	private clear() {
		safe(() => this.storage.session.removeItem(TOKEN_KEY))
		safe(() => this.storage.local.removeItem(TOKEN_KEY))
	}
}

// El almacenamiento puede fallar (modo privado, cuota, bloqueado): nunca rompe la app
function safe<T>(fn: () => T): T | null {
	try {
		return fn()
	} catch {
		return null
	}
}
