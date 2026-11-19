import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it } from 'vitest'
import { newSnapshot } from '../src/data/demo'
import { parseSnapshot, repository } from '../src/data/repository'

const stores = { profile: 'household.id', categories: 'id', members: 'id', transactions: 'id,date,categoryId,memberId,type' }

it('обновляет реальную схему Dexie v1 и сохраняет записи и настройки', async () => {
  const data = newSnapshot(true)
  const categories = data.categories.map(({ id, name, limits, color, archived }) => ({
    id, name, limits, color, archived, icon: id === 'food' ? 'cart' : 'heart',
  }))
  const legacy = new Dexie('budget-local')
  legacy.version(1).stores(stores)
  await legacy.transaction('rw', Object.keys(stores), async () => {
    await legacy.table('profile').put(data.profile)
    await legacy.table('categories').bulkPut(categories)
    await legacy.table('members').bulkPut(data.members)
    await legacy.table('transactions').bulkPut(data.transactions)
  })
  legacy.close()

  const upgraded = (await repository.read())!
  expect(upgraded.version).toBe(2)
  expect(upgraded.categories.find(item => item.id === 'food')).toEqual({
    id: 'food', name: 'Продукты', color: '#a092ff', limits: { week: 700000, month: 2900000 }, archived: false, emoji: '🛒',
  })
  expect(upgraded.profile).toEqual(data.profile)
  expect(upgraded.members).toEqual(data.members)
  expect(upgraded.transactions).toEqual(expect.arrayContaining(data.transactions))
  expect(upgraded.transactions).toHaveLength(data.transactions.length)

  const inspect = new Dexie('budget-local')
  await inspect.open()
  expect(inspect.verno).toBe(2)
  expect(await inspect.table('categories').get('food')).toEqual(upgraded.categories[0])
  inspect.close()
})

it('преобразует старую JSON-копию и сохраняет составные эмодзи при обратном импорте', async () => {
  const data = newSnapshot(false)
  const categories = data.categories.map(({ id, name, limits, color, archived }) => ({
    id, name, limits, color, archived, icon: id === 'food' ? 'cart' : undefined,
  }))
  const migrated = parseSnapshot({ ...data, version: 1, categories })
  expect(migrated.version).toBe(2)
  expect(migrated.categories[0].emoji).toBe('🛒')
  expect(migrated.categories[1].emoji).toBe('📦')

  migrated.categories[0].emoji = '👩🏽‍💻'
  migrated.categories[1].emoji = '🇯🇵'
  await repository.replace(parseSnapshot(JSON.parse(JSON.stringify(migrated))))
  const restored = (await repository.read())!
  expect(restored.categories[0].emoji).toBe('👩🏽‍💻')
  expect(restored.categories[1].emoji).toBe('🇯🇵')
  expect(parseSnapshot(JSON.parse(JSON.stringify(restored)))).toEqual(restored)

  const broken = { ...restored, categories: [{ ...restored.categories[0], emoji: '🍎🥐' }, ...restored.categories.slice(1)] }
  expect(() => parseSnapshot(broken)).toThrow(/эмодзи/)
  expect((await repository.read())?.categories).toEqual(restored.categories)
})
