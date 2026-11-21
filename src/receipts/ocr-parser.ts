export interface ReceiptTextItem {
  originalName: string
  name: string
  quantity: string
  unit?: string
  unitPrice?: number
  amount: number
  discount?: number
  needsReview: boolean
}

export interface ReceiptTextResult {
  store?: string
  date?: string
  total?: number
  transactionType?: 'sale' | 'return' | 'other'
  items: ReceiptTextItem[]
}

const moneyPattern = /(?<![\d.,?])(?:\d{1,3}(?:[ \u202f]\d{3})+|\d+)[.,]\s*\d{2}(?![\d\p{L}.,?])/gu
const quantityPattern = '\\d+(?:[.,]\\d{1,3})?'
const unitPattern = '(?:кг|kg|шт|pcs|мл|ml|г|g|л|l|упак|уп)'
const multiplication = new RegExp(`(?<![\\d.,])(${quantityPattern})\\s*(${unitPattern})?\\.?\\s*[×xх*]\\s*(${quantityPattern})\\s*(${unitPattern})?(?:\\s*(?:₽|руб\\.?))?\\s*(?:[=:<>—–−-]\\s*)?$`, 'iu')
const labeledQuantity = new RegExp(`(${quantityPattern})\\s*(${unitPattern})(?=\\s|\\.|$)`, 'iu')
const totalLabel = /^(?:(?:итог(?:о|овая\s+сумма)?|к\s+оплате|всего(?:\s+к\s+оплате)?|сумма\s+чека|total|amount\s+due))(?=$|[\s:₽=\d])/u
const discountLabel = /^(?:(?:ваша|общая|сумма)\s+)?(?:скидк[аиу]|экономия|discount|выгода)(?=$|[\s:₽=\d-])/u
const netLabel = /^(?:(?:сумма\s+)?с\s+уч[её]том\s+скидки|сумма\s+после\s+скидки)(?=$|[\s:₽=\d])/u
const receiptTitle = /(?:^|[^\p{L}])(?:кассовый[\s.]*чек|чек\s+продажи|товарный\s+чек|receipt|sale)(?=$|[^\p{L}])/u
const transactionLabel = /^(?:приход|возврат\s+прихода|расход|возврат\s+расхода)(?=$|[\s:№])/u
const printedTransaction = /^(приход|возврат\s+прихода|расход|возврат\s+расхода|(?:кассовый\s+)?чек\s+(?:коррекции|возврата))(?=$|\s*(?:[:.]\s*)?\d{1,4}[.,/-]\d|\s*[№])/u
const technical = /^(?:в\s*т\.?\s*ч\.?\s*ндс|ндс|без\s+ндс|сумма\s+ндс|налог|ставка|промежуточный\s+итог|подытог|всего\s+(?:товаров|позиций|наименований)|оплата|оплачено|сдача|наличн\p{L}*|безналичн\p{L}*|электронн\p{L}*|карт(?:а|ой|ы)|сумма\s+(?:наличными|безналичными)|банковск\p{L}*|списано|начислено|баланс|бонус\p{L}*|кассир|касса|смена|инн|фн|фд|фпд?|рн\s*ккт|ккт|зн\s*ккт|рег\.?\s*номер|номер\s+(?:смены|чека|кассы|документа)|заводской\s+номер|чек\s*(?:№|#|[0-9])|сно|снс|осно|усн|офд|фнс|сайт|адрес|телефон|тел\.|место\s+расчетов|код\s+(?:товара|маркировки)|предмет\s+расч[её]та|способ\s+расч[её]та|полный\s+расч[её]т|спасибо|добро\s+пожаловать|дата|время|покупатель)(?=$|[\s:₽.№=%\d])/u
const columnHeading = /^(?:наименование|товар|описание|кол(?:-?во|ичество)|цена|стоимость|сумма|ед\.?(?:\s+изм\.?)?)(?:\s+(?:товара|кол(?:-?во|ичество)|цена|стоимость|сумма|ед\.?|изм\.?))*$/u
const storeLabel = /(?:^|[^\p{L}\d])(?:магазин|супермаркет|гипермаркет|аптека|ооо|ип|ао|пао|зао|продавец|организация)(?=$|[\s:«"—-])|^0{3}\s*[«"]/u
const address = /^(?:(?:\d{6}\s*[,;]?)?\s*(?:россия|рф|г\.|город\s|ул\.|улица\s|проспект\s|пр-т\b|шоссе\s|пос\.|село\s)|(?:[\p{L}.]+\s+)*область\b)/u
const vatSuffix = /\s+(?:ндс|нас|vat)\s*(?:0|10|20|22)(?:\s*%|[17]|\b)/u
const bankCopyHeading = /(?:^терминал|эквайринг|сбербанк.*оплат|банковская\s+операция|платежный\s+терминал)/u
const bankCopyFields = /^(?:сумма\s*\(руб\)|комиссия\s+за\s+операцию|код\s+авторизации|подпись\s+клиента|одобрено|mastercard|visa)(?=$|[^\p{L}])/u

function foldedLabel(line: string): string {
  const lower = line.toLowerCase()
  return /\p{Script=Cyrillic}/u.test(lower)
    ? lower.replace(/[abcehkmoptxy]/g, (letter) => 'авсенкмортху'['abcehkmoptxy'.indexOf(letter)])
    : lower
}

function dateOnLine(line: string): string | undefined {
  const european = /(?:^|[^\d.,])(\d{1,2})([.,/-])(\d{1,2})\2(\d{2}|\d{4})(?![\d.,])/.exec(line)
  const iso = /(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(line)
  const parts = iso ? iso.slice(1) : european && [european[4], european[3], european[1]]
  if (!parts) return undefined
  const year = Number(parts[0]) + (parts[0].length === 2 ? 2000 : 0)
  const month = Number(parts[1])
  const day = Number(parts[2])
  if (year < 1900 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCMonth() !== month - 1) return undefined
  return date.toISOString().slice(0, 10)
}

function moneyOnLine(line: string) {
  return Array.from(line.matchAll(moneyPattern), (match) => {
    const [rubles, kopecks] = match[0].replace(/\s/g, '').split(/[.,]/)
    return { value: Number(rubles) * 100 + Number(kopecks), index: match.index, text: match[0] }
  }).filter((amount) => Number.isSafeInteger(amount.value))
}

function normalizeUnit(unit?: string): string | undefined {
  const lower = unit?.toLowerCase()
  const equivalents: Record<string, string> = { kg: 'кг', g: 'г', pcs: 'шт', l: 'л', ml: 'мл' }
  return lower && (equivalents[lower] ?? lower)
}

function normalizedQuantity(quantity?: string): string | undefined {
  if (!quantity) return undefined
  const normalized = quantity.replace(',', '.').replace(/^0+(?=\d)/, '')
  return Number(normalized) > 0 ? normalized : undefined
}

function likelyName(line: string): boolean {
  return /\p{L}{2}/u.test(line) && !/[?�]/u.test(line) && !/https?:|www\.|@\S|^\d{6}\b/iu.test(line)
}

function stripItemNumber(line: string): string {
  return line.replace(/^[^\p{L}\d№]+/u, '').replace(/^(?:№\s*\d+\s+|\d{1,3}[).]\s+)/u, '').trim()
}

function readItem(rawLine: string, pendingNames: string[]): ReceiptTextItem | undefined {
  const taxTail = vatSuffix.exec(foldedLabel(rawLine))
  const line = taxTail ? rawLine.slice(0, taxTail.index).trimEnd() : rawLine
  const amounts = moneyOnLine(line)
  const amount = amounts.at(-1)
  if (!amount || !/^\s*(?:(?:₽|руб\.?|rub|р\.?)[\s.]*)?$/iu.test(line.slice(amount.index + amount.text.length))) return undefined
  const beforeAmount = line.slice(0, amount.index)
  if (/\d[.,]\s*$/u.test(beforeAmount)) return undefined
  const product = multiplication.exec(beforeAmount)
  const dashSeparator = /[-−]\s*$/.test(beforeAmount)
  if (dashSeparator && !product) return undefined
  const measured = labeledQuantity.exec(beforeAmount)
  let quantity: string | undefined
  let unit: string | undefined
  let unitPrice: number | undefined
  let positionUnclear = false

  if (product) {
    const [, left, leftUnit, right, rightUnit] = product
    const leftIsMoney = /[.,]\d{2}$/.test(left)
    const rightIsMoney = /[.,]\d{2}$/.test(right)
    positionUnclear = !leftUnit && !rightUnit && leftIsMoney === rightIsMoney
    const rightIsQuantity = Boolean(rightUnit || (!leftUnit && leftIsMoney && !rightIsMoney))
    quantity = normalizedQuantity(rightIsQuantity ? right : left)
    unit = normalizeUnit(rightIsQuantity ? rightUnit : leftUnit)
    unitPrice = moneyOnLine(rightIsQuantity ? left : right).at(-1)?.value
  } else if (measured) {
    quantity = normalizedQuantity(measured[1])
    unit = normalizeUnit(measured[2])
    const printedPrice = amounts.at(-2)
    if (printedPrice && printedPrice.index >= measured.index + measured[0].length) unitPrice = printedPrice.value
  }

  const endName = product?.index ?? measured?.index ?? amounts[0].index
  const nameOnLine = stripItemNumber(line.slice(0, endName).replace(/\s*[:=–—-]+\s*$/, ''))
  const originalName = [...pendingNames, ...(likelyName(nameOnLine) ? [nameOnLine] : [])].join('\n')
  if (!originalName) return undefined

  const name = originalName.replace(/\s+/g, ' ').trim()
  const priceDiffers = quantity && unitPrice != null && Math.abs(Math.round(Number(quantity) * unitPrice) - amount.value) > 1
  return {
    originalName, name, quantity: quantity ?? '1', unit, unitPrice, amount: amount.value,
    needsReview: Boolean(dashSeparator || positionUnclear || priceDiffers || (product && unitPrice == null)
      || (!quantity && (amounts.length > 1 || pendingNames.length > 0))),
  }
}

export function parseReceiptText(text: string): ReceiptTextResult {
  const lines = text.normalize('NFKC').replace(/[\u200b\ufeff]/gu, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const result: ReceiptTextResult = { items: [] }
  const heading = lines.findIndex((line) => receiptTitle.test(foldedLabel(line)))
  let pendingNames: string[] = []
  let readingItems = heading <= 0
  let sawTotal = false
  let inBankCopy = false

  for (const [index, line] of lines.entries()) {
    const label = foldedLabel(line)
    const date = dateOnLine(line)
    result.date ??= date
    const printed = printedTransaction.exec(label)?.[1]
    if (printed && result.transactionType !== 'other') {
      if (printed === 'приход') result.transactionType ??= 'sale'
      else result.transactionType = /прихода|чек\s+возврата/u.test(printed) ? 'return' : 'other'
    }

    if (receiptTitle.test(label) || transactionLabel.test(label)) {
      readingItems = true
      inBankCopy = false
      pendingNames = []
      continue
    }

    const amounts = moneyOnLine(line)
    const amount = amounts.at(-1)?.value
    if (totalLabel.test(label) && !technical.test(label)) {
      const following = lines[index + 1] ?? ''
      const splitTotal = /^[=:₽\s]*[\d\s.,]+\s*₽?$/u.test(following) ? moneyOnLine(following).at(-1)?.value : undefined
      result.total ??= amount ?? splitTotal
      sawTotal ||= result.total != null
      pendingNames = []
      continue
    }

    if (sawTotal) continue

    if (bankCopyHeading.test(label)) inBankCopy = true
    if (inBankCopy || bankCopyFields.test(label)) {
      pendingNames = []
      continue
    }

    if (discountLabel.test(label) || netLabel.test(label)) {
      const item = result.items.at(-1)
      if (item && amount != null && !pendingNames.length) {
        if (netLabel.test(label)) item.amount = amount
        else {
          item.discount = amount
          item.needsReview = true
        }
      }
      continue
    }

    if (date || /^[\d./-]+(?:\s+\d{1,2}:\d{2})?$/u.test(line) && amount == null || technical.test(label) || columnHeading.test(label) || address.test(label)) {
      pendingNames = []
      continue
    }

    const shortHeader = index < heading && index < 4 && /^(?:[\p{Lu}]{3,}(?:[ -][\p{Lu}]{2,}){0,2}|\p{Lu}\p{Ll}{3,})$/u.test(line)
    const quotedCompany = /(?:^|\s)((?:ооо|000)\s*[«"][^"»]{2,80}["»])/iu.exec(line)?.[1]
    if (amount == null && likelyName(line) && !result.store && (quotedCompany || storeLabel.test(label) || shortHeader)) {
      result.store = quotedCompany ?? line.replace(/^(?:продавец|организация)\s*:\s*/iu, '')
      continue
    }

    if (!readingItems) continue

    const item = readItem(line, pendingNames)
    if (item) {
      result.items.push(item)
      pendingNames = []
    } else if (amount == null && !vatSuffix.test(label) && likelyName(line)) {
      pendingNames = [...pendingNames.slice(-2), line]
    } else {
      pendingNames = []
    }
  }

  if (result.total) {
    const highAmount = result.total * 4
    result.items = result.items.filter((item) => !item.needsReview || item.amount <= highAmount || item.discount != null)
  }

  return result
}
