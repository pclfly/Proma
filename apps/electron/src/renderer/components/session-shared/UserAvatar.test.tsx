import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { UserAvatar } from './UserAvatar'
import { DEFAULT_USER_AVATAR } from '../../../types/user-profile'

describe('共享用户头像的初始展示', () => {
  for (const avatar of ['https://fixture.invalid/avatar.png', 'data:image/png;base64,fixture']) {
    test(`Given 图片头像 ${avatar.slice(0, 18)} When 尚未完成加载 Then 同尺寸默认占位且图片隐藏`, () => {
      const html = renderToStaticMarkup(<UserAvatar avatar={avatar} size={32} />)
      expect(html).toContain(DEFAULT_USER_AVATAR)
      expect(html).toContain('opacity-0')
      expect(html).toContain('width:32px;height:32px')
      expect(html).toContain('用户头像')
    })
  }
  test('Given emoji When 渲染 Then 保留用户选择而不发图片请求', () => {
    const html = renderToStaticMarkup(<UserAvatar avatar="🐼" size={40} className="fixture-class" />)
    expect(html).toContain('🐼')
    expect(html).not.toContain('<img')
    expect(html).toContain('fixture-class')
    expect(html).toContain('width:40px;height:40px')
  })
})
