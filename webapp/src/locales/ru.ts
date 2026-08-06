export const ru = {
  app: {
    name: 'Task Commander',
    localEnvironment: 'Локальный контур',
    foundationReady: 'Основа проекта готова к развитию.',
    foundationDescription:
      'React, Cloudflare Workers и общий API-контракт запущены в едином локальном окружении.',
  },
  navigation: {
    home: 'Основа',
    status: 'Статус контура',
  },
  health: {
    title: 'Соединение с API',
    loading: 'Проверяем соединение с локальным API…',
    ready: 'Локальный Hono API отвечает корректно.',
    unavailable: 'Не удалось получить ответ от API.',
    retry: 'Повторить',
    unexpectedResponse: 'API вернул неожиданный ответ.',
  },
  status: {
    title: 'Статус локального контура',
    panelLabel: 'Панель',
    apiPanel: 'API',
    runtimePanel: 'Runtime',
    tableComponent: 'Компонент',
    tableState: 'Состояние',
    apiComponent: 'Локальный API',
    ready: 'Готов',
    unavailable: 'Недоступен',
    checking: 'Проверяется',
  },
  viewport: {
    title: 'Нужен экран большего размера',
    description: 'Task Commander первого этапа поддерживает только десктопный интерфейс.',
  },
} as const;
