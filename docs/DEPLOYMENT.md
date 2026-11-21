# Cloudflare Pages и D1

Команды выполняются из корня Budget. Для локальной разработки нужен Node.js 24. Для пересборки C++ в WebAssembly установите Emscripten из инструкции финансового ядра. [Сборка C++ и WASM](CPP_WASM.md).

## Локальная среда

```sh
npm ci
npm run build
npm run db:local
npm run dev:cloud
```

Откройте `http://127.0.0.1:8788`. Wrangler поднимает Pages Functions и локальную D1. Состояние хранится в `.wrangler/`. После изменений интерфейса повторите `npm run build`. Если нужен только локальный режим приложения, запустите `npm run dev`. Вызываемые вручную JSON-запросы API должны использовать тот же origin, что и адрес запущенного сервера.

```sh
npm run test:cloud
npx playwright install chromium webkit
npm run test:e2e:cloud
```

## Публикация после отдельного разрешения

1. Если Wrangler ещё не авторизован, выполните `npx wrangler login`. Для первой публикации создайте проект командой `npx wrangler pages project create budget-nikita --production-branch main`. При выборе другого имени укажите его также в поле `name` файла `wrangler.jsonc`. [Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/).
2. Для существующего проекта D1 `budget` уже создана. Для нового окружения выполните `npx wrangler d1 create budget` и укажите полученный `database_id` в `env.production.d1_databases` файла `wrangler.jsonc`. Верхний раздел `d1_databases` используется при локальной разработке. В обоих разделах API ожидает привязку с именем `DB`. Для preview-развёртываний настройте отдельную D1 в `env.preview.d1_databases` и примените к ней миграции отдельно. [Конфигурация Pages Functions](https://developers.cloudflare.com/pages/functions/wrangler-configuration/#environment-specific-overrides).
3. Выполните `npx wrangler d1 migrations apply budget --env production --remote`. Для следующих обновлений сначала сравните миграции командой `npx wrangler d1 migrations list budget --env production --remote` и сделайте резервную копию действующих финансовых данных.
4. Выполните `npm run build`. Команда использует готовый WASM из проекта. Если меняли C++-ядро, сначала выполните `npm run build:wasm`. Запустите `npx wrangler pages deploy dist --project-name budget-nikita --branch main` из корня, чтобы Wrangler собрал также каталог `functions/`. В Dashboard в **Workers & Pages → проект → Settings → Bindings** проверьте, что имя `DB` указывает на нужную D1. [D1 bindings для Pages](https://developers.cloudflare.com/pages/functions/bindings/#d1-databases).
5. Проверьте `https://ИМЯ_ПРОЕКТА.pages.dev/api/v1/session` в браузере без сессии. Ожидается статус `401` и JSON с заголовком `Cache-Control: private, no-store`. Убедитесь, что на странице загружается файл `.wasm` с типом `application/wasm` и приложение открывается с установленным Service Worker.

API не требует настроек секретов. Для будущих секретов используйте **Settings → Variables and Secrets** проекта Pages или команду `npx wrangler pages secret put ИМЯ --project-name ИМЯ_ПРОЕКТА`. Храните авторизацию Wrangler на машине разработчика или через секреты CI. [Переменные и секреты Pages](https://developers.cloudflare.com/pages/functions/bindings/#environment-variables).

## Установка на двух iPhone

1. Откройте HTTPS-адрес в Safari на каждом iPhone. В меню Safari выберите «Поделиться» → «На экран Домой», включите «Открывать как веб‑приложение», если есть этот переключатель, и нажмите «Добавить». Откройте Budget с домашнего экрана. [Инструкция Apple](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).
2. На первом телефоне создайте общий бюджет или подтвердите перенос текущих данных. Сохраните свой код восстановления. В настройках общего бюджета нажмите «Пригласить» и передайте ссылку второму участнику.
3. На втором телефоне откройте установленный Budget, выберите «Присоединиться к бюджету» и вставьте ссылку в форму. Подтвердите имя и сохраните отдельный код восстановления.
4. Добавьте расход 500 ₽ на первом телефоне. Откройте Budget на втором или верните его на передний план и дождитесь синхронизации. Затем выключите сеть на втором телефоне, добавьте свою операцию, верните сеть и дождитесь её появления на первом. Установите разные часовые пояса телефонов и проверьте, что оба показывают одинаковую финансовую неделю бюджета.


## Обновление и восстановление

Публикуйте изменения в production-ветку проекта и проверяйте основной адрес Pages. Уникальный URL развёртывания указывает на конкретную сборку. После публикации откройте установленное приложение онлайн и нажмите «Обновить приложение», когда появится предложение об обновлении.

Если приложение показывает старую сборку, проверьте основной адрес в Safari. Перед удалением ярлыка или очисткой данных сохраните JSON и убедитесь, что очередь общего бюджета отправлена. Для восстановления доступа используйте код участника. Данные с устройств и D1 восстанавливаются разными способами, описанными в [разделе о базах данных](DATABASE.md).

При неудачном выпуске сначала проверьте журналы Pages Functions, привязку D1 и состояние миграций. Откат Pages переключает версию приложения и функций. Изменения схемы D1 оцениваются отдельно. Лимиты тарифа смотрите в [документации Cloudflare](https://developers.cloudflare.com/d1/platform/limits/).
