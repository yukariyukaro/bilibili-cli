globalThis.fetch = async (url) => {
  const address = String(url)
  if (address.includes('/generate')) return { json: async () => ({ data: { qrcode_key: '测试二维码', url: 'https://example.invalid/扫码测试' } }) }
  if (address.includes('/poll')) {
    return {
      headers: { getSetCookie: () => ['SESSDATA=仅限测试的凭证; Path=/', 'bili_jct=测试令牌; Path=/', 'buvid3=测试指纹; Path=/', 'DedeUserID=123; Path=/'] },
      json: async () => ({ data: { code: address.includes('waiting') ? 86101 : 0 } }),
    }
  }
  throw new Error('测试禁止访问真实网络')
}
