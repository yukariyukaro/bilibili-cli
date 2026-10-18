import { register } from 'node:module'

register(new URL('./python-hook.mjs', import.meta.url))
