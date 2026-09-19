const STORAGE_KEY = 'portfolio-dashboard-v1';
const MANUAL_CRYPTO_KEY = 'portfolio-manual-crypto-v1';
const MANUAL_CRYPTO_SALES_KEY = 'portfolio-manual-crypto-sales-v1';
const HIDDEN_POSITIONS_KEY = 'portfolio-hidden-positions-v1';
const COST_BASIS_KEY = 'portfolio-crypto-cost-basis-v1';
const CURRENCY_KEY = 'portfolio-currency-v1';
const PRIVACY_KEY = 'portfolio-privacy-mode-v1';
const RATES_CACHE_KEY = 'portfolio-exchange-rates-v1';
const CARD_ORDER_KEY = 'portfolio-card-order-v1';
const EXPENSES_KEY = 'portfolio-expenses-v1';
const EXPENSE_VIEW_KEY = 'portfolio-expense-view-v1';
const EXPENSE_ENTRIES_SORT_KEY = 'portfolio-expense-entries-sort-v1';
const EXPENSE_BREAKDOWN_FILTER_KEY = 'portfolio-expense-breakdown-filter-v1';
const CUSTOM_EXPENSE_CATEGORIES_KEY = 'portfolio-custom-expense-categories-v1';
const HIDDEN_EXPENSE_CATEGORIES_KEY = 'portfolio-hidden-expense-categories-v1';
const CATEGORY_COLOR_OVERRIDES_KEY = 'portfolio-category-color-overrides-v1';
const EXPENSE_DEFAULT_ACCOUNT_KEY = 'portfolio-expense-default-account-v1';
const NUMBER_DECIMALS_KEY = 'portfolio-number-decimals-v1';
const DECIMAL_SEPARATOR_KEY = 'portfolio-decimal-separator-v1';
const MERGE_STAKED_KEY = 'portfolio-merge-staked-v1';
const WEEK_START_KEY = 'portfolio-week-start-v1';
const LANGUAGE_KEY = 'portfolio-language-v1';
const NEWS_SORT_KEY = 'portfolio-news-sort-v1';
const NEWS_PANEL_WIDTH_KEY = 'portfolio-news-panel-width-v1';
const FORM_PANEL_WIDTH_KEY = 'portfolio-form-panel-width-v1';
// Local dev talks to the relay on localhost:3002 (a different port than the
// original app's server.js on 3001 — see the matching comment in
// server.js). A deployed page needs the relay's real deployed URL instead —
// update the production line below to match wherever it actually ends up
// (e.g. Render assigns https://<service-name>.onrender.com based on the
// service name chosen at creation).
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://localhost:3002'
  : 'https://tradone.onrender.com'; // Render service name is "Tradone", not "tradone-relay"

// Declared this early (rather than down with the rest of the Portfolio News
// code) because refreshAvanzaCard/refreshCryptoPortfolioCard's call to
// scheduleNewsRefresh() can fire synchronously during page boot — e.g.
// selectCurrency(displayCurrency) below restores the saved currency and
// cascades straight into refreshAvanzaCard before the script has finished
// its first pass. A `let` declared later would still be in its temporal
// dead zone at that point and throw.
let newsRefreshTimer = null;

// ── Display currency ─────────────────────────────────────────────────────────
// Every value in the app is fetched in either USD (crypto) or the position's
// own trading currency (Avanza, e.g. SEK) — this converts everything to one
// chosen display currency at format time rather than storing converted values,
// so switching currency never needs a re-fetch.

let displayCurrency = localStorage.getItem(CURRENCY_KEY) || 'USD';

// ── Privacy mode ──────────────────────────────────────────────────────────
// Masks every formatted number (balances, prices, P&L, %) behind the word
// "hidden" so the screen can be shown around without leaking amounts. Each
// run of digits/decimal-point/thousands-separators collapses into a single
// "hidden" — currency symbols and signs stay put so the shape of a value
// (negative, percentage, ...) is still visible at a glance.
let privacyMode = localStorage.getItem(PRIVACY_KEY) === 'true';

function maskIfPrivate(formatted) {
  return privacyMode ? String(formatted).replace(/[0-9.,]+/g, 'hidden') : formatted;
}

// ── Number display settings ──────────────────────────────────────────────
// Three independent knobs over how every number in the app is formatted —
// set on the Settings page and applied globally, rather than each formatter
// picking its own fraction-digit count/locale like before.

// Number(null) is 0 (not NaN), which would silently pass the validity check
// below and default to 0 decimals instead of 2 — so a missing key has to be
// treated as "invalid" explicitly rather than left for Number() to coerce.
const storedNumberDecimals = localStorage.getItem(NUMBER_DECIMALS_KEY);
let numberDecimals = storedNumberDecimals != null ? Number(storedNumberDecimals) : NaN;
if (!Number.isFinite(numberDecimals) || numberDecimals < 0 || numberDecimals > 6) numberDecimals = 2;

// 'period' (1,234.56, the Intl.NumberFormat('en-US', ...) default everywhere
// else in this file), 'comma' (1.234,56), or 'space' (1 234.56 — thousands
// grouping only, decimal point stays a period).
const VALID_SEPARATOR_STYLES = ['period', 'comma', 'space'];
const storedSeparatorStyle = localStorage.getItem(DECIMAL_SEPARATOR_KEY);
let decimalSeparatorStyle = VALID_SEPARATOR_STYLES.includes(storedSeparatorStyle) ? storedSeparatorStyle : 'period';

// Whether a staked position (e.g. staked SOL, Kiln staked ETH) merges into
// the same row as its liquid counterpart of the same coin, or gets its own
// row — see isStakedPosition/groupPositionsBySymbol below.
let mergeStakedPositions = localStorage.getItem(MERGE_STAKED_KEY) !== 'false';

// Which day starts the week in the Expenses calendar view (see
// renderExpenseCalendar below) — 'monday' or 'sunday'. Deliberately doesn't
// touch getSelectedExpensePeriod's own "This week" stat, which has always
// been Monday-start regardless of this setting.
let weekStart = localStorage.getItem(WEEK_START_KEY);
if (!['monday', 'sunday'].includes(weekStart)) weekStart = 'monday';

// ── Language ─────────────────────────────────────────────────────────────
// Every static string in index.html carries a data-i18n[-placeholder/-title/
// -aria-label/-html] attribute naming a key here; applyStaticTranslations()
// (defined near the bottom, once every DOM element it touches exists) walks
// those on load and on every language switch. Strings built by JS template
// literals (card titles, stat labels, position fields, ...) call t(key)
// directly instead. A handful of count-dependent phrases (accounts
// connected, positions hidden, ...) skip the flat key lookup entirely and
// use their own small per-language function below, since English needs a
// singular/plural split that a single key can't express — rather than build
// a general plural-rules engine for three languages and a handful of
// strings, Russian/Chinese use one invariant phrasing that reads naturally
// at any count.
const VALID_LANGUAGES = ['en', 'ru', 'zh'];
const storedLanguage = localStorage.getItem(LANGUAGE_KEY);
let currentLanguage = VALID_LANGUAGES.includes(storedLanguage) ? storedLanguage : 'en';

const TRANSLATIONS = {
  en: {
    'auth.heading': 'Log in',
    'auth.sub': 'Your account is stored locally on this device only.',
    'auth.chooseUsername': 'Choose a username',
    'auth.choosePassword': 'Choose a password',
    'auth.createAccount': 'Create account',
    'auth.toggleToRegister': 'Need an account? Register instead',
    'auth.toggleToLogin': 'Already have an account? Log in',

    'common.username': 'Username',
    'common.password': 'Password',
    'common.logIn': 'Log in',
    'common.displayName': 'Display name',
    'common.balance': 'Balance',
    'common.remove': 'Remove',
    'common.refresh': 'Refresh',
    'common.cancel': 'Cancel',
    'common.connected': 'Connected',
    'common.disconnect': 'Disconnect',
    'common.addedManually': 'Added manually',
    'common.setDate': 'Set date',
    'common.lastUpdated': 'Last updated',

    'nav.portfolio': 'Portfolio',
    'nav.expenses': 'Expenses',
    'nav.settings': 'Settings',

    'hero.eyebrow': 'Portfolio dashboard',
    'hero.title': 'Monitor your crypto and broker positions in one place.',
    'hero.copy': 'Add wallet addresses, brokerage accounts, and track your current balance at a glance.',
    'hero.loggedInAs': 'Logged in as',
    'hero.logout': 'Log out',

    'heroCard.totalPortfolio': 'Total portfolio',
    'heroCard.hideBalances': 'Hide balances',
    'heroCard.showBalances': 'Show balances',
    'heroCard.displayCurrency': 'Display currency',

    'addAccount.heading': 'Add account',
    'addAccount.note': 'Choose a type to connect it live — positions merge straight into your accounts below.',
    'addAccount.typeLabel': 'Account type',

    'accountType.crypto': 'Crypto wallet',
    'accountType.broker': 'Broker account',
    'accountType.paypal': 'PayPal',
    'accountType.bank': 'Bank account',
    'accountType.savings': 'Savings account',
    'accountType.investment': 'Investment account',
    'accountType.retirement': 'Retirement account',
    'accountType.other': 'Other',

    'crypto.note': "Paste any wallet address — Ethereum, BNB Smart Chain, Optimism, Solana, NEAR, XRP, Litecoin, Stellar, or TON — the chain is detected automatically and merged into your Crypto Portfolio card. A 0x… address is checked against Ethereum, BNB Smart Chain, and Optimism together, since the same address can hold funds on all three.",
    'crypto.walletAddressLabel': 'Wallet address',
    'crypto.loadWalletBtn': 'Load wallet',
    'crypto.manualToggle': 'Enter values manually instead',
    'crypto.manualNamePlaceholder': 'Example: Cold storage BTC',
    'crypto.coinSymbolLabel': 'Coin symbol',
    'crypto.coinAmountLabel': 'Amount of coins',
    'crypto.coingeckoLabel': 'CoinGecko link (optional)',
    'crypto.coingeckoNote': "If given, the current value is looked up automatically from that coin's live price — leave the value below blank.",
    'crypto.currentValueLabel': 'Current value (USD)',
    'crypto.addPositionBtn': 'Add crypto position',
    'crypto.logSaleToggle': 'Log a sale',
    'crypto.logSaleNote': "Wallet activity can't reliably tell a sale apart from a transfer to your own wallet, a swap, or a staking deposit — so sales are logged by hand here instead of detected automatically.",
    'crypto.saleDateLabel': 'Date sold',
    'crypto.saleQuantityLabel': 'Quantity sold',
    'crypto.saleBuyPriceLabel': 'Buy price per coin (USD)',
    'crypto.saleSellPriceLabel': 'Sale price per coin (USD)',
    'crypto.logSaleBtn': 'Log sale',

    'broker.bankidNote': 'Scan the QR code with the BankID app on your phone to log in.',
    'broker.showBankidBtn': 'Show BankID QR code',
    'broker.usePasswordInstead': 'Use username/password instead',
    'broker.totpNote': 'Requires TOTP-based two-factor authentication to be enabled on your Avanza account (not BankID/SMS).',
    'broker.totpLabel': '2FA code',
    'broker.useBankidInstead': 'Use BankID instead',
    'broker.connectingToAvanza': 'Connecting to Avanza…',
    'broker.bankidHint': 'Open BankID on your phone and scan the code.',
    'broker.fetchingAccounts': 'Fetching accounts…',
    'broker.refreshAccountsBtn': 'Refresh accounts',
    'broker.manualToggle': 'Enter account manually instead',
    'broker.manualIdLabel': 'Wallet ID or account ID',
    'broker.mainBrokeragePlaceholder': 'Example: Main brokerage',
    'broker.addAccountBtn': 'Add broker account',

    'paypal.note': 'Requires a PayPal <strong>Business</strong> account with a REST API app — create one at developer.paypal.com and paste its Client ID and Secret below. Personal PayPal accounts have no API for reading a balance.',
    'paypal.clientIdLabel': 'Client ID',
    'paypal.clientIdPlaceholder': 'PayPal REST API Client ID',
    'paypal.clientSecretLabel': 'Client Secret',
    'paypal.clientSecretPlaceholder': 'PayPal REST API Secret',
    'paypal.envLabel': 'Environment',
    'paypal.envLive': 'Live',
    'paypal.envSandbox': 'Sandbox',
    'paypal.connectBtn': 'Connect PayPal',
    'paypal.connecting': 'Connecting to PayPal…',
    'paypal.fetchingBalance': 'Fetching balance…',
    'paypal.refreshBalanceBtn': 'Refresh balance',

    'flat.note': 'Add this account with its own balance.',
    'flat.namePlaceholder': 'Example: Everyday savings',
    'flat.annualReturnLabel': 'Expected annual return (%)',
    'flat.annualReturnNote': "Used to estimate this account's everyday return, shown on its card below.",
    'flat.addAccountBtn': 'Add account',
    'flat.currencyNote': "Values are entered in {currency} — the portfolio's current display currency. Change it with the currency switcher above the total.",

    'accounts.heading': 'Your accounts',
    'accounts.sub': 'Live overview of tracked positions',
    'emptyState.noAccounts': 'No accounts yet. Add your first wallet or broker above.',

    'news.heading': 'Portfolio news',
    'news.refresh': 'Refresh',
    'news.sortLabel': 'Sort',
    'news.sortNewest': 'Newest first',
    'news.sortOldest': 'Oldest first',
    'news.sortAsset': 'By stock/crypto',
    'news.assetFilterLabel': 'Show',
    'news.assetFilterAll': 'All',
    'news.sub': 'Latest headlines for what you hold',
    'news.cryptoBadge': 'Crypto',
    'news.marketBadge': 'Market',
    'news.empty': 'No news yet — add a wallet, broker account, or coin to see headlines here.',
    'news.loading': 'Loading news…',
    'news.readFull': 'Read full article',
    'news.noSummary': 'No summary available.',

    'expenses.addHeading': 'Add expense',
    'expenses.addNote': "Log a purchase — it's grouped into the category breakdown for whatever period you're looking at below.",
    'expenses.typeLabel': 'Type',
    'expenses.typeExpense': 'Expense',
    'expenses.typeEarning': 'Earning',
    'expenses.categoryLabel': 'Category',
    'expenses.removeCategoryTitle': 'Remove this category',
    'expenses.changeColorTitle': 'Change color',
    'expenses.newCategoryPlaceholder': 'New category name',
    'expenses.addCategoryBtn': 'Add',
    'expenses.descriptionLabel': 'Description (optional)',
    'expenses.descriptionPlaceholder': 'Example: Weekly grocery run',
    'expenses.amountLabel': 'Amount',
    'expenses.dateLabel': 'Date',
    'expenses.accountLabel': 'Account (optional)',
    'expenses.accountNone': 'No linked account',
    'expenses.accountNote': "Linking an account deducts (or adds, for an earning) this amount from its balance and refreshes its daily return estimate.",
    'expenses.addExpenseBtn': 'Add expense',
    'expenses.spendingOverviewHeading': 'Spending overview',
    'expenses.viewList': 'List',
    'expenses.viewWheel': 'Wheel',
    'expenses.viewCalendar': 'Calendar',
    'expenses.filterExpenses': 'Expenses',
    'expenses.filterEarnings': 'Earnings',
    'expenses.periodLabel': 'Period',
    'expenses.periodWeek': 'This week',
    'expenses.periodMonth': 'This month',
    'expenses.periodAll': 'All time',
    'expenses.periodCustom': 'Custom range',
    'expenses.weekTotalLabel': 'Total',
    'expenses.fromLabel': 'From',
    'expenses.toLabel': 'To',
    'expenses.totalSpent': 'Total spent',
    'expenses.totalEarned': 'Total earned',
    'expenses.totalActivity': 'Total activity',
    'expenses.net': 'Net',
    'expenses.dailyAverage': 'Daily average',
    'expenses.entries': 'Entries',
    'expenses.topCategory': 'Top category',
    'expenses.entriesHeading': 'Entries',
    'expenses.entriesSub': 'In the selected period, newest first',
    'expenses.entriesSubByCategory': 'In the selected period, grouped by category',
    'expenses.sortByCategory': 'Category',
    'expenses.removeTitle': 'Remove this expense',
    'emptyState.noExpenses': 'No expenses logged for this period.',
    'emptyState.noExpenseBreakdown': 'No activity in this period yet.',

    'expenseCategory.groceries': 'Groceries',
    'expenseCategory.dining': 'Dining out',
    'expenseCategory.transport': 'Transport',
    'expenseCategory.housing': 'Housing',
    'expenseCategory.utilities': 'Utilities',
    'expenseCategory.entertainment': 'Entertainment',
    'expenseCategory.health': 'Health',
    'expenseCategory.shopping': 'Shopping',
    'expenseCategory.other': 'Other',

    'earningCategory.salary': 'Salary',
    'earningCategory.freelance': 'Freelance',
    'earningCategory.gift': 'Gift',
    'earningCategory.refund': 'Refund',
    'earningCategory.investment': 'Investment income',
    'earningCategory.other': 'Other',


    'settings.heading': 'Display settings',
    'settings.sub': 'Controls how numbers are formatted across the whole dashboard',
    'settings.decimalPlacesLabel': 'Decimal places',
    'settings.decimalOption0': '0 — e.g. $1,234',
    'settings.decimalOption1': '1 — e.g. $1,234.5',
    'settings.decimalOption2': '2 — e.g. $1,234.56',
    'settings.decimalOption3': '3 — e.g. $1,234.567',
    'settings.decimalOption4': '4 — e.g. $1,234.5678',
    'settings.separatorLabel': 'Decimal separator',
    'settings.separatorPeriod': 'Period — 1,234.56',
    'settings.separatorComma': 'Comma — 1.234,56',
    'settings.separatorSpace': 'Space — 1 234.56',
    'settings.languageLabel': 'Language',
    'settings.stakedLabel': 'Staked crypto positions',
    'settings.stakedMerged': 'Merge with liquid balance — one combined row per coin',
    'settings.stakedSeparate': 'Show separately — staked and liquid as their own rows',
    'settings.weekStartLabel': 'Week starts on',
    'settings.weekStartMonday': 'Monday',
    'settings.weekStartSunday': 'Sunday',

    'card.cryptoPortfolio': 'Crypto Portfolio',
    'card.avanza': 'Avanza',
    'card.paypal': 'PayPal',
    'card.noSourcesLoaded': 'No sources loaded',
    'card.walletStakedPositions': 'Wallet + staked positions',
    'card.trackedPosition': 'Tracked position',
    'card.cryptoDisclaimer': 'Cost above only reflects ETH, Solana, Litecoin, Stellar, XRP, and TON positions with a known historical price (see the coverage count) — BNB Smart Chain, Optimism, and NEAR still have no cost-basis data at all (their transaction history requires a paid explorer API), so they count toward Current Value with an assumed cost of $0, i.e. their whole value shows up as Gain/Loss. Current Value − Cost always equals the displayed Gain/Loss. "First Received" is when an asset first arrived in this wallet, not necessarily when it was purchased, so an internal transfer between your own wallets can show a fake gain or loss. Prices only resolve for assets received within the last 365 days (CoinGecko free tier limit). Hover a position and click × to hide it (e.g. spam airdrops).',
    'card.showAll': 'show all',
    'card.linkedExpenses': "Last 7 days' transactions",
    'card.noLinkedExpenses': 'No expenses linked to this account yet — link one from the Expenses page.',
    'card.noRecentLinkedExpenses': 'Nothing in the last 7 days.',
    'card.viewAllExpenses': 'View all →',

    'stat.currentValue': 'Current Value',
    'stat.cost': 'Initial Cost',
    'stat.totalReturn': 'Total Return',
    'stat.totalInvested': 'Total Invested',
    'stat.balance': 'Balance',
    'stat.firstReceived': 'First Received',
    'stat.currentPrice': 'Current Price',
    'stat.unrealizedPnl': 'Unrealized P&L',
    'stat.openPnl': 'Open P&L',
    'stat.change': 'Change',
    'stat.shares': 'Shares',
    'stat.firstBuy': 'First Buy',
    'stat.avgBuyPrice': 'Avg Buy Price',
    'stat.realizedPnl': 'Realized P&L',
    'stat.soldDate': 'Sold',
    'stat.sellPrice': 'Sell Price',

    'edit.accountType': 'Account type',
    'edit.walletId': 'Wallet ID or account ID',
    'edit.annualReturn': 'Expected annual return (%)',
    'edit.saveChanges': 'Save changes',
    'edit.cancel': 'Cancel'
  },
  ru: {
    'auth.heading': 'Вход',
    'auth.sub': 'Ваш аккаунт хранится только локально на этом устройстве.',
    'auth.chooseUsername': 'Придумайте имя пользователя',
    'auth.choosePassword': 'Придумайте пароль',
    'auth.createAccount': 'Создать аккаунт',
    'auth.toggleToRegister': 'Нет аккаунта? Зарегистрироваться',
    'auth.toggleToLogin': 'Уже есть аккаунт? Войти',

    'common.username': 'Имя пользователя',
    'common.password': 'Пароль',
    'common.logIn': 'Войти',
    'common.displayName': 'Название',
    'common.balance': 'Баланс',
    'common.remove': 'Удалить',
    'common.refresh': 'Обновить',
    'common.cancel': 'Отмена',
    'common.connected': 'Подключено',
    'common.disconnect': 'Отключить',
    'common.addedManually': 'Добавлено вручную',
    'common.setDate': 'Указать дату',
    'common.lastUpdated': 'Обновлено',

    'nav.portfolio': 'Портфель',
    'nav.expenses': 'Расходы',
    'nav.settings': 'Настройки',

    'hero.eyebrow': 'Панель портфеля',
    'hero.title': 'Отслеживайте крипту и брокерские счета в одном месте.',
    'hero.copy': 'Добавьте адреса кошельков и брокерские счета, чтобы видеть текущий баланс с первого взгляда.',
    'hero.loggedInAs': 'Вы вошли как',
    'hero.logout': 'Выйти',

    'heroCard.totalPortfolio': 'Общий портфель',
    'heroCard.hideBalances': 'Скрыть баланс',
    'heroCard.showBalances': 'Показать баланс',
    'heroCard.displayCurrency': 'Валюта отображения',

    'addAccount.heading': 'Добавить счёт',
    'addAccount.note': 'Выберите тип, чтобы подключить его напрямую — позиции сразу добавятся в ваши счета ниже.',
    'addAccount.typeLabel': 'Тип счёта',

    'accountType.crypto': 'Криптокошелёк',
    'accountType.broker': 'Брокерский счёт',
    'accountType.paypal': 'PayPal',
    'accountType.bank': 'Банковский счёт',
    'accountType.savings': 'Сберегательный счёт',
    'accountType.investment': 'Инвестиционный счёт',
    'accountType.retirement': 'Пенсионный счёт',
    'accountType.other': 'Другое',

    'crypto.note': 'Вставьте любой адрес кошелька — Ethereum, BNB Smart Chain, Optimism, Solana, NEAR, XRP, Litecoin, Stellar или TON — сеть определяется автоматически и объединяется в карточке «Криптопортфель». Адрес вида 0x… проверяется сразу в Ethereum, BNB Smart Chain и Optimism, поскольку один и тот же адрес может хранить средства во всех трёх сетях.',
    'crypto.walletAddressLabel': 'Адрес кошелька',
    'crypto.loadWalletBtn': 'Загрузить кошелёк',
    'crypto.manualToggle': 'Ввести значения вручную',
    'crypto.manualNamePlaceholder': 'Например: холодное хранилище BTC',
    'crypto.coinSymbolLabel': 'Символ монеты',
    'crypto.coinAmountLabel': 'Количество монет',
    'crypto.coingeckoLabel': 'Ссылка на CoinGecko (необязательно)',
    'crypto.coingeckoNote': 'Если указана, текущая стоимость будет автоматически подтягиваться из актуальной цены монеты — в этом случае поле значения ниже можно оставить пустым.',
    'crypto.currentValueLabel': 'Текущая стоимость (USD)',
    'crypto.addPositionBtn': 'Добавить криптопозицию',
    'crypto.logSaleToggle': 'Записать продажу',
    'crypto.logSaleNote': 'По активности кошелька нельзя достоверно отличить продажу от перевода на свой же кошелёк, обмена или стейкинга — поэтому продажи вносятся вручную, а не определяются автоматически.',
    'crypto.saleDateLabel': 'Дата продажи',
    'crypto.saleQuantityLabel': 'Проданное количество',
    'crypto.saleBuyPriceLabel': 'Цена покупки за монету (USD)',
    'crypto.saleSellPriceLabel': 'Цена продажи за монету (USD)',
    'crypto.logSaleBtn': 'Записать продажу',

    'broker.bankidNote': 'Отсканируйте QR-код приложением BankID на телефоне, чтобы войти.',
    'broker.showBankidBtn': 'Показать QR-код BankID',
    'broker.usePasswordInstead': 'Использовать логин и пароль',
    'broker.totpNote': 'Требуется двухфакторная аутентификация на основе TOTP, включённая в вашем аккаунте Avanza (не BankID/SMS).',
    'broker.totpLabel': 'Код 2FA',
    'broker.useBankidInstead': 'Использовать BankID',
    'broker.connectingToAvanza': 'Подключение к Avanza…',
    'broker.bankidHint': 'Откройте BankID на телефоне и отсканируйте код.',
    'broker.fetchingAccounts': 'Загрузка счетов…',
    'broker.refreshAccountsBtn': 'Обновить счета',
    'broker.manualToggle': 'Ввести счёт вручную',
    'broker.manualIdLabel': 'ID кошелька или счёта',
    'broker.mainBrokeragePlaceholder': 'Например: основной брокерский счёт',
    'broker.addAccountBtn': 'Добавить брокерский счёт',

    'paypal.note': 'Требуется бизнес-аккаунт PayPal с приложением REST API — создайте его на developer.paypal.com и вставьте Client ID и Secret ниже. У личных аккаунтов PayPal нет API для чтения баланса.',
    'paypal.clientIdLabel': 'Client ID',
    'paypal.clientIdPlaceholder': 'Client ID PayPal REST API',
    'paypal.clientSecretLabel': 'Client Secret',
    'paypal.clientSecretPlaceholder': 'Secret PayPal REST API',
    'paypal.envLabel': 'Окружение',
    'paypal.envLive': 'Боевое',
    'paypal.envSandbox': 'Песочница',
    'paypal.connectBtn': 'Подключить PayPal',
    'paypal.connecting': 'Подключение к PayPal…',
    'paypal.fetchingBalance': 'Загрузка баланса…',
    'paypal.refreshBalanceBtn': 'Обновить баланс',

    'flat.note': 'Добавьте этот счёт с указанием его баланса.',
    'flat.namePlaceholder': 'Например: повседневные сбережения',
    'flat.annualReturnLabel': 'Ожидаемая годовая доходность (%)',
    'flat.annualReturnNote': 'Используется для оценки повседневной доходности этого счёта, отображаемой на его карточке.',
    'flat.addAccountBtn': 'Добавить счёт',
    'flat.currencyNote': 'Значения вводятся в {currency} — текущей валюте отображения портфеля. Измените её переключателем валют над общей суммой.',

    'accounts.heading': 'Ваши счета',
    'accounts.sub': 'Актуальный обзор отслеживаемых позиций',
    'emptyState.noAccounts': 'Пока нет счетов. Добавьте свой первый кошелёк или брокерский счёт выше.',

    'news.heading': 'Новости портфеля',
    'news.refresh': 'Обновить',
    'news.sortLabel': 'Сортировка',
    'news.sortNewest': 'Сначала новые',
    'news.sortOldest': 'Сначала старые',
    'news.sortAsset': 'По акции/крипте',
    'news.assetFilterLabel': 'Показать',
    'news.assetFilterAll': 'Все',
    'news.sub': 'Последние новости по вашим активам',
    'news.cryptoBadge': 'Крипто',
    'news.marketBadge': 'Рынок',
    'news.empty': 'Пока нет новостей — добавьте кошелёк, брокерский счёт или монету, чтобы увидеть новости здесь.',
    'news.loading': 'Загрузка новостей…',
    'news.readFull': 'Читать статью полностью',
    'news.noSummary': 'Описание недоступно.',

    'expenses.addHeading': 'Добавить расход',
    'expenses.addNote': 'Запишите покупку — она попадёт в разбивку по категориям за выбранный ниже период.',
    'expenses.typeLabel': 'Тип',
    'expenses.typeExpense': 'Расход',
    'expenses.typeEarning': 'Доход',
    'expenses.categoryLabel': 'Категория',
    'expenses.removeCategoryTitle': 'Удалить эту категорию',
    'expenses.changeColorTitle': 'Изменить цвет',
    'expenses.newCategoryPlaceholder': 'Название новой категории',
    'expenses.addCategoryBtn': 'Добавить',
    'expenses.descriptionLabel': 'Описание (необязательно)',
    'expenses.descriptionPlaceholder': 'Например: еженедельные продукты',
    'expenses.amountLabel': 'Сумма',
    'expenses.dateLabel': 'Дата',
    'expenses.accountLabel': 'Счёт (необязательно)',
    'expenses.accountNone': 'Без привязки к счёту',
    'expenses.accountNote': 'Привязка счёта спишет (или начислит, для дохода) эту сумму с его баланса и обновит оценку дневного дохода.',
    'expenses.addExpenseBtn': 'Добавить расход',
    'expenses.spendingOverviewHeading': 'Обзор расходов',
    'expenses.viewList': 'Список',
    'expenses.viewWheel': 'Круговая',
    'expenses.viewCalendar': 'Календарь',
    'expenses.filterExpenses': 'Расходы',
    'expenses.filterEarnings': 'Доходы',
    'expenses.periodLabel': 'Период',
    'expenses.periodWeek': 'Эта неделя',
    'expenses.periodMonth': 'Этот месяц',
    'expenses.periodAll': 'Всё время',
    'expenses.periodCustom': 'Свой период',
    'expenses.weekTotalLabel': 'Итого',
    'expenses.fromLabel': 'С',
    'expenses.toLabel': 'По',
    'expenses.totalSpent': 'Всего потрачено',
    'expenses.totalEarned': 'Всего заработано',
    'expenses.totalActivity': 'Всего операций',
    'expenses.net': 'Итого',
    'expenses.dailyAverage': 'В среднем за день',
    'expenses.entries': 'Записей',
    'expenses.topCategory': 'Топ-категория',
    'expenses.entriesHeading': 'Записи',
    'expenses.entriesSub': 'За выбранный период, сначала новые',
    'expenses.entriesSubByCategory': 'За выбранный период, сгруппировано по категориям',
    'expenses.sortByCategory': 'Категория',
    'expenses.removeTitle': 'Удалить этот расход',
    'emptyState.noExpenses': 'За этот период расходов не найдено.',
    'emptyState.noExpenseBreakdown': 'В этом периоде пока нет операций.',

    'expenseCategory.groceries': 'Продукты',
    'expenseCategory.dining': 'Рестораны',
    'expenseCategory.transport': 'Транспорт',
    'expenseCategory.housing': 'Жильё',
    'expenseCategory.utilities': 'Коммунальные услуги',
    'expenseCategory.entertainment': 'Развлечения',
    'expenseCategory.health': 'Здоровье',
    'expenseCategory.shopping': 'Покупки',
    'expenseCategory.other': 'Другое',

    'earningCategory.salary': 'Зарплата',
    'earningCategory.freelance': 'Фриланс',
    'earningCategory.gift': 'Подарок',
    'earningCategory.refund': 'Возврат',
    'earningCategory.investment': 'Инвестиционный доход',
    'earningCategory.other': 'Другое',


    'settings.heading': 'Настройки отображения',
    'settings.sub': 'Определяет формат чисел во всей панели',
    'settings.decimalPlacesLabel': 'Знаков после запятой',
    'settings.decimalOption0': '0 — напр. $1,234',
    'settings.decimalOption1': '1 — напр. $1,234.5',
    'settings.decimalOption2': '2 — напр. $1,234.56',
    'settings.decimalOption3': '3 — напр. $1,234.567',
    'settings.decimalOption4': '4 — напр. $1,234.5678',
    'settings.separatorLabel': 'Разделитель дробной части',
    'settings.separatorPeriod': 'Точка — 1,234.56',
    'settings.separatorComma': 'Запятая — 1.234,56',
    'settings.separatorSpace': 'Пробел — 1 234.56',
    'settings.languageLabel': 'Язык',
    'settings.stakedLabel': 'Застейканные криптопозиции',
    'settings.stakedMerged': 'Объединять с ликвидным балансом — одна общая строка на монету',
    'settings.stakedSeparate': 'Показывать отдельно — застейканные и ликвидные в своих строках',
    'settings.weekStartLabel': 'Неделя начинается с',
    'settings.weekStartMonday': 'Понедельника',
    'settings.weekStartSunday': 'Воскресенья',

    'card.cryptoPortfolio': 'Криптопортфель',
    'card.avanza': 'Avanza',
    'card.paypal': 'PayPal',
    'card.noSourcesLoaded': 'Источники не загружены',
    'card.walletStakedPositions': 'Кошелёк + застейканные позиции',
    'card.trackedPosition': 'Отслеживаемая позиция',
    'card.cryptoDisclaimer': 'Стоимость выше учитывает только позиции ETH, Solana, Litecoin, Stellar, XRP и TON с известной исторической ценой (см. счётчик покрытия) — у BNB Smart Chain, Optimism и NEAR пока нет данных о базовой стоимости (для истории транзакций нужен платный API эксплорера), поэтому они полностью учитываются в текущей стоимости с предполагаемой базовой стоимостью $0, т.е. вся их стоимость отображается как прибыль/убыток. Текущая стоимость − Базовая стоимость всегда равна показанной прибыли/убытку. «Первое поступление» — это момент, когда актив впервые оказался в этом кошельке, не обязательно момент покупки, поэтому перевод между вашими же кошельками может показать фиктивную прибыль или убыток. Цены определяются только для активов, полученных за последние 365 дней (ограничение бесплатного тарифа CoinGecko). Наведите на позицию и нажмите ×, чтобы скрыть её (например, спам-airdrop).',
    'card.showAll': 'показать все',
    'card.linkedExpenses': 'Транзакции за последние 7 дней',
    'card.noLinkedExpenses': 'К этому счёту пока не привязано ни одного расхода — привяжите его на странице «Расходы».',
    'card.noRecentLinkedExpenses': 'За последние 7 дней ничего нет.',
    'card.viewAllExpenses': 'Смотреть все →',

    'stat.currentValue': 'Текущая стоимость',
    'stat.cost': 'Начальная стоимость',
    'stat.totalReturn': 'Общая доходность',
    'stat.totalInvested': 'Всего вложено',
    'stat.balance': 'Баланс',
    'stat.firstReceived': 'Первое поступление',
    'stat.currentPrice': 'Текущая цена',
    'stat.unrealizedPnl': 'Нереализованная прибыль/убыток',
    'stat.openPnl': 'Открытая прибыль/убыток',
    'stat.change': 'Изменение',
    'stat.shares': 'Акции',
    'stat.firstBuy': 'Первая покупка',
    'stat.avgBuyPrice': 'Средняя цена покупки',
    'stat.realizedPnl': 'Реализованная прибыль/убыток',
    'stat.soldDate': 'Продано',
    'stat.sellPrice': 'Цена продажи',

    'edit.accountType': 'Тип счёта',
    'edit.walletId': 'ID кошелька или счёта',
    'edit.annualReturn': 'Ожидаемая годовая доходность (%)',
    'edit.saveChanges': 'Сохранить',
    'edit.cancel': 'Отмена'
  },
  zh: {
    'auth.heading': '登录',
    'auth.sub': '您的账户仅保存在本设备本地。',
    'auth.chooseUsername': '设置用户名',
    'auth.choosePassword': '设置密码',
    'auth.createAccount': '创建账户',
    'auth.toggleToRegister': '还没有账户？去注册',
    'auth.toggleToLogin': '已有账户？去登录',

    'common.username': '用户名',
    'common.password': '密码',
    'common.logIn': '登录',
    'common.displayName': '显示名称',
    'common.balance': '余额',
    'common.remove': '删除',
    'common.refresh': '刷新',
    'common.cancel': '取消',
    'common.connected': '已连接',
    'common.disconnect': '断开连接',
    'common.addedManually': '手动添加',
    'common.setDate': '设置日期',
    'common.lastUpdated': '最后更新',

    'nav.portfolio': '投资组合',
    'nav.expenses': '支出',
    'nav.settings': '设置',

    'hero.eyebrow': '投资组合仪表盘',
    'hero.title': '在一个地方监控您的加密货币和券商持仓。',
    'hero.copy': '添加钱包地址和券商账户，一目了然地追踪当前余额。',
    'hero.loggedInAs': '当前登录：',
    'hero.logout': '退出登录',

    'heroCard.totalPortfolio': '投资组合总值',
    'heroCard.hideBalances': '隐藏余额',
    'heroCard.showBalances': '显示余额',
    'heroCard.displayCurrency': '显示货币',

    'addAccount.heading': '添加账户',
    'addAccount.note': '选择一种类型进行实时连接——持仓将直接合并到下方的账户中。',
    'addAccount.typeLabel': '账户类型',

    'accountType.crypto': '加密钱包',
    'accountType.broker': '券商账户',
    'accountType.paypal': 'PayPal',
    'accountType.bank': '银行账户',
    'accountType.savings': '储蓄账户',
    'accountType.investment': '投资账户',
    'accountType.retirement': '退休账户',
    'accountType.other': '其他',

    'crypto.note': '粘贴任意钱包地址——Ethereum、BNB Smart Chain、Optimism、Solana、NEAR、XRP、Litecoin、Stellar 或 TON——系统会自动识别链并合并到您的"加密投资组合"卡片中。0x… 开头的地址会同时在 Ethereum、BNB Smart Chain 和 Optimism 上查询，因为同一地址可能在这三条链上都持有资产。',
    'crypto.walletAddressLabel': '钱包地址',
    'crypto.loadWalletBtn': '加载钱包',
    'crypto.manualToggle': '改为手动输入',
    'crypto.manualNamePlaceholder': '例如：冷存储 BTC',
    'crypto.coinSymbolLabel': '币种符号',
    'crypto.coinAmountLabel': '币的数量',
    'crypto.coingeckoLabel': 'CoinGecko 链接（可选）',
    'crypto.coingeckoNote': '如果填写，当前价值会根据该币种的实时价格自动计算——此时可将下方的价值留空。',
    'crypto.currentValueLabel': '当前价值（USD）',
    'crypto.addPositionBtn': '添加加密持仓',
    'crypto.logSaleToggle': '记录一笔卖出',
    'crypto.logSaleNote': '钱包活动无法可靠区分卖出与转到自己的其他钱包、兑换或质押存入——因此卖出记录需要手动填写，而不是自动检测。',
    'crypto.saleDateLabel': '卖出日期',
    'crypto.saleQuantityLabel': '卖出数量',
    'crypto.saleBuyPriceLabel': '每枚买入价（USD）',
    'crypto.saleSellPriceLabel': '每枚卖出价（USD）',
    'crypto.logSaleBtn': '记录卖出',

    'broker.bankidNote': '用手机上的 BankID 应用扫描二维码即可登录。',
    'broker.showBankidBtn': '显示 BankID 二维码',
    'broker.usePasswordInstead': '改用用户名和密码',
    'broker.totpNote': '需要您的 Avanza 账户已启用基于 TOTP 的双重验证（不支持 BankID/短信）。',
    'broker.totpLabel': '双重验证码',
    'broker.useBankidInstead': '改用 BankID',
    'broker.connectingToAvanza': '正在连接 Avanza…',
    'broker.bankidHint': '请在手机上打开 BankID 并扫描二维码。',
    'broker.fetchingAccounts': '正在获取账户…',
    'broker.refreshAccountsBtn': '刷新账户',
    'broker.manualToggle': '改为手动添加账户',
    'broker.manualIdLabel': '钱包 ID 或账户 ID',
    'broker.mainBrokeragePlaceholder': '例如：主券商账户',
    'broker.addAccountBtn': '添加券商账户',

    'paypal.note': '需要拥有带 REST API 应用的 PayPal 商业账户——请在 developer.paypal.com 创建一个，并在下方粘贴其 Client ID 和 Secret。个人 PayPal 账户没有读取余额的 API。',
    'paypal.clientIdLabel': 'Client ID',
    'paypal.clientIdPlaceholder': 'PayPal REST API Client ID',
    'paypal.clientSecretLabel': 'Client Secret',
    'paypal.clientSecretPlaceholder': 'PayPal REST API Secret',
    'paypal.envLabel': '环境',
    'paypal.envLive': '正式环境',
    'paypal.envSandbox': '沙盒环境',
    'paypal.connectBtn': '连接 PayPal',
    'paypal.connecting': '正在连接 PayPal…',
    'paypal.fetchingBalance': '正在获取余额…',
    'paypal.refreshBalanceBtn': '刷新余额',

    'flat.note': '添加此账户并填写其余额。',
    'flat.namePlaceholder': '例如：日常储蓄',
    'flat.annualReturnLabel': '预期年化收益率（%）',
    'flat.annualReturnNote': '用于估算该账户的日常收益，并显示在其卡片上。',
    'flat.addAccountBtn': '添加账户',
    'flat.currencyNote': '数值以 {currency} 输入——即投资组合当前的显示货币。可通过总额上方的货币切换器更改。',

    'accounts.heading': '您的账户',
    'accounts.sub': '已追踪持仓的实时概览',
    'emptyState.noAccounts': '暂无账户。请在上方添加您的第一个钱包或券商账户。',

    'news.heading': '投资组合新闻',
    'news.refresh': '刷新',
    'news.sortLabel': '排序',
    'news.sortNewest': '最新优先',
    'news.sortOldest': '最早优先',
    'news.sortAsset': '按股票/加密货币',
    'news.assetFilterLabel': '显示',
    'news.assetFilterAll': '全部',
    'news.sub': '与您持仓相关的最新头条',
    'news.cryptoBadge': '加密货币',
    'news.marketBadge': '市场',
    'news.empty': '暂无新闻——添加钱包、券商账户或币种后即可在此查看头条新闻。',
    'news.loading': '正在加载新闻…',
    'news.readFull': '阅读全文',
    'news.noSummary': '暂无摘要。',

    'expenses.addHeading': '添加支出',
    'expenses.addNote': '记录一笔消费——它会计入下方所选周期的分类统计中。',
    'expenses.typeLabel': '类型',
    'expenses.typeExpense': '支出',
    'expenses.typeEarning': '收入',
    'expenses.categoryLabel': '类别',
    'expenses.removeCategoryTitle': '移除此类别',
    'expenses.newCategoryPlaceholder': '新类别名称',
    'expenses.addCategoryBtn': '添加',
    'expenses.descriptionLabel': '描述（可选）',
    'expenses.descriptionPlaceholder': '例如：每周购物',
    'expenses.amountLabel': '金额',
    'expenses.dateLabel': '日期',
    'expenses.accountLabel': '账户（可选）',
    'expenses.accountNone': '不关联账户',
    'expenses.accountNote': '关联账户会从其余额中扣除（收入则增加）此金额，并刷新其每日收益估算。',
    'expenses.addExpenseBtn': '添加支出',
    'expenses.spendingOverviewHeading': '支出概览',
    'expenses.viewList': '列表',
    'expenses.viewWheel': '饼图',
    'expenses.viewCalendar': '日历',
    'expenses.filterExpenses': '支出',
    'expenses.filterEarnings': '收入',
    'expenses.periodLabel': '周期',
    'expenses.periodWeek': '本周',
    'expenses.periodMonth': '本月',
    'expenses.periodAll': '全部时间',
    'expenses.periodCustom': '自定义范围',
    'expenses.weekTotalLabel': '合计',
    'expenses.fromLabel': '从',
    'expenses.toLabel': '至',
    'expenses.totalSpent': '总支出',
    'expenses.totalEarned': '总收入',
    'expenses.totalActivity': '总收支',
    'expenses.net': '净额',
    'expenses.dailyAverage': '日均支出',
    'expenses.entries': '记录数',
    'expenses.topCategory': '最高类别',
    'expenses.entriesHeading': '记录',
    'expenses.entriesSub': '所选周期内，最新在前',
    'expenses.entriesSubByCategory': '所选周期内，按类别分组',
    'expenses.sortByCategory': '类别',
    'expenses.removeTitle': '删除此笔支出',
    'emptyState.noExpenses': '此周期内没有支出记录。',
    'emptyState.noExpenseBreakdown': '此周期内暂无任何记录。',

    'expenseCategory.groceries': '日用品',
    'expenseCategory.dining': '外出就餐',
    'expenseCategory.transport': '交通',
    'expenseCategory.housing': '住房',
    'expenseCategory.utilities': '水电煤',
    'expenseCategory.entertainment': '娱乐',
    'expenseCategory.health': '健康',
    'expenseCategory.shopping': '购物',
    'expenseCategory.other': '其他',

    'earningCategory.salary': '工资',
    'earningCategory.freelance': '自由职业',
    'earningCategory.gift': '礼物',
    'earningCategory.refund': '退款',
    'earningCategory.investment': '投资收入',
    'earningCategory.other': '其他',


    'settings.heading': '显示设置',
    'settings.sub': '控制整个仪表盘中数字的显示格式',
    'settings.decimalPlacesLabel': '小数位数',
    'settings.decimalOption0': '0 — 例如 $1,234',
    'settings.decimalOption1': '1 — 例如 $1,234.5',
    'settings.decimalOption2': '2 — 例如 $1,234.56',
    'settings.decimalOption3': '3 — 例如 $1,234.567',
    'settings.decimalOption4': '4 — 例如 $1,234.5678',
    'settings.separatorLabel': '小数分隔符',
    'settings.separatorPeriod': '句点 — 1,234.56',
    'settings.separatorComma': '逗号 — 1.234,56',
    'settings.separatorSpace': '空格 — 1 234.56',
    'settings.languageLabel': '语言',
    'settings.stakedLabel': '质押中的加密持仓',
    'settings.stakedMerged': '与活期余额合并 — 每个币种一行',
    'settings.stakedSeparate': '单独显示 — 质押与活期各自成行',
    'settings.weekStartLabel': '一周从',
    'settings.weekStartMonday': '星期一开始',
    'settings.weekStartSunday': '星期日开始',

    'card.cryptoPortfolio': '加密投资组合',
    'card.avanza': 'Avanza',
    'card.paypal': 'PayPal',
    'card.noSourcesLoaded': '尚未加载任何来源',
    'card.walletStakedPositions': '钱包 + 质押持仓',
    'card.trackedPosition': '已追踪持仓',
    'card.cryptoDisclaimer': '以上成本仅反映 ETH、Solana、Litecoin、Stellar、XRP 和 TON 中具有已知历史价格的持仓（见覆盖计数）——BNB Smart Chain、Optimism 和 NEAR 目前完全没有成本数据（其交易历史需要付费的浏览器 API），因此它们会以假定成本 $0 计入当前价值，也就是说它们的全部价值都会显示为盈亏。当前价值 − 成本 始终等于显示的盈亏。"首次收到"指资产首次进入该钱包的时间，不一定是购买时间，因此在您自己的钱包之间转账可能会显示虚假的盈利或亏损。价格仅能解析最近 365 天内收到的资产（CoinGecko 免费套餐的限制）。将鼠标悬停在持仓上并点击 × 即可隐藏它（例如垃圾空投）。',
    'card.showAll': '显示全部',
    'card.linkedExpenses': '最近 7 天的交易',
    'card.noLinkedExpenses': '此账户尚未关联任何支出 —— 请在支出页面关联一笔。',
    'card.noRecentLinkedExpenses': '最近 7 天没有记录。',
    'card.viewAllExpenses': '查看全部 →',

    'stat.currentValue': '当前价值',
    'stat.cost': '初始成本',
    'stat.totalReturn': '总回报率',
    'stat.totalInvested': '总投入',
    'stat.balance': '余额',
    'stat.firstReceived': '首次收到',
    'stat.currentPrice': '当前价格',
    'stat.unrealizedPnl': '未实现盈亏',
    'stat.openPnl': '未平仓盈亏',
    'stat.change': '涨跌幅',
    'stat.shares': '股数',
    'stat.firstBuy': '首次买入',
    'stat.avgBuyPrice': '平均买入价',
    'stat.realizedPnl': '已实现盈亏',
    'stat.soldDate': '卖出日期',
    'stat.sellPrice': '卖出价',

    'edit.accountType': '账户类型',
    'edit.walletId': '钱包 ID 或账户 ID',
    'edit.annualReturn': '预期年化收益率（%）',
    'edit.saveChanges': '保存更改',
    'edit.cancel': '取消'
  }
};

function t(key) {
  return TRANSLATIONS[currentLanguage]?.[key] ?? TRANSLATIONS.en[key] ?? key;
}

function tAccountsConnected(n) {
  if (currentLanguage === 'ru') return `Подключено счетов: ${n}`;
  if (currentLanguage === 'zh') return `已连接 ${n} 个账户`;
  return `${n} account${n === 1 ? '' : 's'} connected`;
}

function tPositionsHidden(n) {
  if (currentLanguage === 'ru') return `Скрыто позиций: ${n}`;
  if (currentLanguage === 'zh') return `已隐藏 ${n} 个持仓`;
  return `${n} position${n === 1 ? '' : 's'} hidden`;
}

function tMoreLinkedExpenses(n) {
  if (currentLanguage === 'ru') return `+ ещё ${n} старше 7 дней — смотреть все на странице «Расходы»`;
  if (currentLanguage === 'zh') return `另有 ${n} 笔 7 天前的记录 —— 前往支出页面查看全部`;
  return `+${n} more from before that — view all on the Expenses page`;
}

function tCoverageLabel(known, total) {
  if (currentLanguage === 'ru') return ` (известно для ${known} из ${total})`;
  if (currentLanguage === 'zh') return `（${total} 个持仓中 ${known} 个已知）`;
  return ` (${known} of ${total} position${total === 1 ? '' : 's'})`;
}

function tCurrenciesTracked(n) {
  if (currentLanguage === 'ru') return `Отслеживается валют: ${n}`;
  if (currentLanguage === 'zh') return `正在追踪 ${n} 种货币`;
  return `${n} currenc${n === 1 ? 'y' : 'ies'} tracked`;
}

// Every currency/percent value is built by Intl.NumberFormat('en-US', ...),
// which always punctuates as period-decimal/comma-thousands — swapping both
// characters in one pass is enough to turn that into comma-decimal/
// period-thousands (1,234.56 -> 1.234,56) without needing a different
// locale (which would also fight the currency-symbol placement this app
// otherwise relies on staying put across every supported currency).
function applyDecimalSeparator(formatted) {
  if (decimalSeparatorStyle === 'comma') return formatted.replace(/[.,]/g, (ch) => (ch === '.' ? ',' : '.'));
  if (decimalSeparatorStyle === 'space') return formatted.replace(/,/g, ' ');
  return formatted;
}

// Rates are relative to USD (rate.USD === 1); Frankfurter is ECB-backed, free,
// and needs no API key. Cached for 12h so switching currency doesn't refetch.
let exchangeRates = { USD: 1 };

async function loadExchangeRates() {
  try {
    const cached = JSON.parse(localStorage.getItem(RATES_CACHE_KEY) || 'null');
    if (cached && Date.now() - cached.fetchedAt < 12 * 60 * 60 * 1000) {
      exchangeRates = cached.rates;
      return;
    }

    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD');
    const data = await res.json();
    exchangeRates = { USD: 1, ...data.rates };
    localStorage.setItem(RATES_CACHE_KEY, JSON.stringify({ rates: exchangeRates, fetchedAt: Date.now() }));
  } catch {
    // Falls back to whatever's already in exchangeRates (USD-only on first
    // ever load) — non-USD amounts just won't convert until this succeeds.
  }
}

// Converts an amount from its source currency into the current display
// currency. Falls back to the untouched amount if either currency's rate is
// unknown, rather than showing a wrong number under a misleading symbol.
function convertToDisplayCurrency(value, fromCurrency = 'USD') {
  if (value == null) return value;
  const fromRate = exchangeRates[fromCurrency];
  const toRate = exchangeRates[displayCurrency];
  if (fromRate == null || toRate == null) return value;
  return (value / fromRate) * toRate;
}

// Manual accounts (the `accounts` array) always store their balance in USD —
// same convention as convertToDisplayCurrency, just fixed to USD as the
// target instead of whatever's currently selected — so a bank account
// entered in, say, SEK converts once at add-time and then behaves exactly
// like every other manual account from then on.
function convertToUSD(value, fromCurrency = 'USD') {
  if (value == null) return value;
  const fromRate = exchangeRates[fromCurrency];
  if (fromRate == null) return value;
  return value / fromRate;
}

// Global "something is loading" indicator — a thin bar at the top of the
// page. Uses a counter rather than a boolean so overlapping requests (e.g. a
// wallet load kicking off a profile sync) don't let one finishing early hide
// the bar while another is still in flight.
const globalLoadingBar = document.getElementById('global-loading-bar');
let activeLoadingCount = 0;

function beginLoading() {
  activeLoadingCount++;
  globalLoadingBar.classList.add('active');
}

function endLoading() {
  activeLoadingCount = Math.max(0, activeLoadingCount - 1);
  if (activeLoadingCount === 0) globalLoadingBar.classList.remove('active');
}

// Wraps an async function so the loading bar shows for its whole duration,
// including when it throws — used to bracket every user-triggered fetch.
async function withLoading(fn) {
  beginLoading();
  try {
    return await fn();
  } finally {
    endLoading();
  }
}

// Individually hidden coins/positions (e.g. spam airdrops) — persisted
// separately from the manual accounts, since they apply to live data.
const hiddenPositionIds = new Set(JSON.parse(localStorage.getItem(HIDDEN_POSITIONS_KEY) || '[]'));

function saveHiddenPositionIds() {
  localStorage.setItem(HIDDEN_POSITIONS_KEY, JSON.stringify([...hiddenPositionIds]));
}

// Per-position { firstReceivedDate, priceAtFirstReceived }, keyed by
// cryptoPositionId — remembers a cost basis two ways: (1) once CoinGecko
// successfully prices a wallet position's first-received date, that price is
// kept here forever, so it's still available once that date falls outside
// CoinGecko's ~365-day free-tier history window on some future reload where
// the server would otherwise come back with priceAtFirstReceived: null; and
// (2) for a position the chain could never determine a date for at all
// (BNB Smart Chain/Optimism/NEAR, or a failed lookup on another chain), it
// holds whatever date+price the user set by hand via the "Set date" row
// action. Applied in applyCostBasisOverride, below.
const costBasisOverrides = JSON.parse(localStorage.getItem(COST_BASIS_KEY) || '{}');

function saveCostBasisOverrides() {
  localStorage.setItem(COST_BASIS_KEY, JSON.stringify(costBasisOverrides));
}

const defaultAccounts = [
  {
    id: crypto.randomUUID(),
    type: 'wallet',
    name: 'Main Wallet',
    identifier: '0xA1b2C3d4E5f6...',
    balance: 12450,
    positions: [
      { symbol: 'BTC', amount: '0.42', value: 18200 },
      { symbol: 'ETH', amount: '12.5', value: 3200 }
    ]
  },
  {
    id: crypto.randomUUID(),
    type: 'broker',
    name: 'Avanza',
    identifier: 'SE-884321',
    balance: 34250,
    positions: [
      { symbol: 'AAPL', amount: '13', value: 5400 },
      { symbol: 'MSFT', amount: '8', value: 3600 }
    ]
  }
];

let accounts = loadAccounts();
let manualCryptoPositions = loadManualCryptoPositions();
// Manually-logged closed crypto trades (realized P&L) — on-chain transfers
// aren't reliably "sales" (could be a self-transfer, a swap, a staking
// deposit), so unlike Avanza's broker-confirmed sells, these are entered by
// hand rather than inferred from wallet activity.
let manualCryptoSales = loadManualCryptoSales();

// Live data loaded from the wallet / Avanza integrations — not persisted,
// rendered as extra cards inside the same "Your accounts" list.
let liveAccounts = [];
const expandedIds = new Set();

// User-chosen display order for account cards (manual and live alike),
// persisted by card id so a drag-to-reorder survives a reload. Cards not
// yet in this list (new accounts, freshly connected sources) sort after
// every known id, in whatever order they were otherwise rendered.
let cardOrder = loadCardOrder();

function loadCardOrder() {
  try {
    return JSON.parse(localStorage.getItem(CARD_ORDER_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveCardOrder() {
  localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(cardOrder));
}

// Keeps cardOrder in sync with whatever cards actually exist right now:
// appends ids it hasn't seen yet (so they get a stable position once the
// user starts dragging), and drops ids for cards that no longer exist
// (removed/disconnected accounts) so the list doesn't grow stale forever.
function reconcileCardOrder(currentIds) {
  const present = new Set(currentIds);
  let next = cardOrder.filter((id) => present.has(id));
  for (const id of currentIds) {
    if (!next.includes(id)) next.push(id);
  }
  if (next.length !== cardOrder.length || next.some((id, i) => id !== cardOrder[i])) {
    cardOrder = next;
    saveCardOrder();
  }
}

function sortByCardOrder(items, getId) {
  const orderIndex = new Map(cardOrder.map((id, i) => [id, i]));
  return [...items].sort((a, b) => (orderIndex.get(getId(a)) ?? Infinity) - (orderIndex.get(getId(b)) ?? Infinity));
}

// ── Custom select ────────────────────────────────────────────────────────────
// Every <select> in the app (account type, expense category/period, the
// inline account-edit type picker) gets wrapped in this so they all share
// the same floating-listbox look as the currency switcher above the total,
// instead of the browser's native <select> popup. The underlying <select>
// stays in the DOM (hidden) and is still what every other piece of code
// reads/writes/listens to — this only replaces how the choice is presented
// and picked, dispatching a real 'change' event on the real select so
// existing listeners keep working untouched.
//
// Outside-click/Escape-to-close is wired once globally via
// customSelectWrappers rather than per call, since render() recreates the
// inline edit form's type select (and re-runs enhanceSelect) on every
// account add/edit/remove — a per-instance document listener would leak one
// on every single render.
const customSelectWrappers = new Set();
const customSelectSyncFns = new Map();

function enhanceSelect(selectEl) {
  if (selectEl.dataset.enhanced) return;
  selectEl.dataset.enhanced = 'true';
  selectEl.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'custom-select-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `
    <span class="custom-select-label"></span>
    <svg class="dropdown-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
  const label = btn.querySelector('.custom-select-label');

  const menu = document.createElement('ul');
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');

  function syncFromSelect() {
    const options = [...selectEl.options];
    menu.innerHTML = options
      .map((opt) => {
        const selected = opt.value === selectEl.value;
        return `<li role="option" data-value="${opt.value}" class="${selected ? 'selected' : ''}" aria-selected="${selected}">${opt.textContent}</li>`;
      })
      .join('');
    const current = options.find((opt) => opt.value === selectEl.value);
    label.textContent = current ? current.textContent : '';
  }

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    wrapper.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(wrapper.classList.contains('open')));
  });

  menu.addEventListener('click', (event) => {
    const li = event.target.closest('li[data-value]');
    if (!li) return;
    selectEl.value = li.dataset.value;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    syncFromSelect();
    wrapper.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(menu);
  selectEl.insertAdjacentElement('afterend', wrapper);
  syncFromSelect();

  customSelectWrappers.add(wrapper);
  customSelectSyncFns.set(selectEl, syncFromSelect);
}

// Re-syncs an already-enhanced select's button label/menu highlight after
// its .value was changed directly in code (rather than through the custom
// menu itself) — plain assignment doesn't fire 'change', so nothing else
// would otherwise notice.
function refreshCustomSelect(selectEl) {
  customSelectSyncFns.get(selectEl)?.();
}

document.addEventListener('click', (event) => {
  for (const wrapper of customSelectWrappers) {
    if (!wrapper.isConnected) {
      customSelectWrappers.delete(wrapper);
      continue;
    }
    if (!wrapper.contains(event.target)) wrapper.classList.remove('open');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  customSelectWrappers.forEach((wrapper) => wrapper.classList.remove('open'));
});

// ── Add-account type switcher ───────────────────────────────────────────────
// "Crypto wallet" and "Broker account" each get their own live-connect panel;
// every flat-balance type (bank, savings, investment, retirement, other)
// shares one generic panel, since they're all just a name + balance —
// only one panel is visible at a time, toggled by the type select below.

const newAccountType   = document.getElementById('new-account-type');
const cryptoSubsection = document.getElementById('crypto-subsection');
const brokerSubsection = document.getElementById('broker-subsection');
const paypalSubsection = document.getElementById('paypal-subsection');
const flatSubsection   = document.getElementById('flat-subsection');
const flatAnnualReturnWrap = document.getElementById('flat-annual-return-wrap');
const flatAnnualReturnNote = document.getElementById('flat-annual-return-note');
const flatAnnualReturnInput = document.getElementById('flat-annual-return');
const accountsList = document.getElementById('accounts-list');
const totalPortfolio = document.getElementById('total-portfolio');
const accountCount = document.getElementById('account-count');

// Every account type that's just a flat name + balance with no live data
// source and no ID field — kept as one list so the type switcher, the edit
// form, and the manual-card renderer all agree on what counts as "bank-like".
const FLAT_ACCOUNT_TYPES = ['bank', 'savings', 'investment', 'retirement', 'other'];

// Of the flat types, these three carry an expected annual return so the
// dashboard can estimate an everyday return for them — a bank/other balance
// has no yield assumption attached to it.
const ANNUAL_RETURN_TYPES = ['savings', 'investment', 'retirement'];

function updateAccountTypeView() {
  const value = newAccountType.value;
  cryptoSubsection.style.display = value === 'crypto' ? '' : 'none';
  brokerSubsection.style.display = value === 'broker' ? '' : 'none';
  paypalSubsection.style.display = value === 'paypal' ? '' : 'none';
  flatSubsection.style.display   = FLAT_ACCOUNT_TYPES.includes(value) ? '' : 'none';
  const showAnnualReturn = ANNUAL_RETURN_TYPES.includes(value);
  flatAnnualReturnWrap.style.display = showAnnualReturn ? '' : 'none';
  flatAnnualReturnNote.style.display = showAnnualReturn ? '' : 'none';
  // A required-but-hidden field still fails the form's constraint validation
  // in some browsers (Chromium included) — switching from a return-bearing
  // type back to e.g. "Bank" while annual return was already filled in would
  // otherwise silently block "Add account" with no visible error, since the
  // browser can't focus a hidden control to report why. Toggling `required`
  // off (and clearing any leftover value) whenever the field isn't shown
  // keeps it out of validation entirely while it doesn't apply.
  flatAnnualReturnInput.required = showAnnualReturn;
  if (!showAnnualReturn) flatAnnualReturnInput.value = '';
}
newAccountType.addEventListener('change', updateAccountTypeView);
updateAccountTypeView();
enhanceSelect(newAccountType);

// ── Top-level page navigation ───────────────────────────────────────────────
// Only one of these top-level pages is visible at a time — the nav just swaps
// which one, same toggle-by-data-attribute pattern as the account type
// switcher above. Expenses' own stats are recomputed on the way in rather
// than kept live, since nothing changes them while that page isn't showing.

const appNav = document.getElementById('app-nav');
const settingsGearBtn = document.getElementById('settings-gear-btn');
const pagePortfolio = document.getElementById('page-portfolio');
const pageExpenses = document.getElementById('page-expenses');
const pageSettings = document.getElementById('page-settings');

// The gear button lives outside #app-nav (it's pinned to the page's top-right
// corner rather than sitting in the pill row), so it gets its own "active"
// state toggled in lockstep with the in-nav buttons instead of sharing their
// event-delegation container.
function goToPage(page) {
  appNav.querySelectorAll('.app-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  settingsGearBtn.classList.toggle('active', page === 'settings');
  pagePortfolio.style.display = page === 'portfolio' ? '' : 'none';
  pageExpenses.style.display = page === 'expenses' ? '' : 'none';
  pageSettings.style.display = page === 'settings' ? '' : 'none';
  if (page === 'expenses') renderExpenses();
  // Same staggered entrance reveal the app plays on login, replayed for
  // whichever page just became visible — playPopInAnimation only picks up
  // elements that are actually rendered (offsetParent !== null), so it
  // naturally targets just the page now showing.
  const shownPage = page === 'portfolio' ? pagePortfolio
    : page === 'expenses' ? pageExpenses
    : pageSettings;
  playPopInAnimation(shownPage);
}

appNav.addEventListener('click', (event) => {
  const btn = event.target.closest('.app-nav-btn[data-page]');
  if (!btn) return;
  goToPage(btn.dataset.page);
});

settingsGearBtn.addEventListener('click', () => goToPage('settings'));

// ── Settings page ────────────────────────────────────────────────────────────
// Three number-display preferences (see numberDecimals/decimalSeparatorStyle/
// mergeStakedPositions above) — every change re-runs refreshAllDisplays() so
// the effect is visible immediately across both other pages, not just here.

const settingsDecimalsSelect  = document.getElementById('settings-decimals');
const settingsSeparatorSelect = document.getElementById('settings-decimal-separator');
const settingsLanguageSelect  = document.getElementById('settings-language');
const settingsStakedSelect    = document.getElementById('settings-staked-display');
const settingsWeekStartSelect = document.getElementById('settings-week-start');

settingsDecimalsSelect.value = String(numberDecimals);
settingsSeparatorSelect.value = decimalSeparatorStyle;
settingsLanguageSelect.value = currentLanguage;
settingsStakedSelect.value = mergeStakedPositions ? 'merged' : 'separate';
settingsWeekStartSelect.value = weekStart;

enhanceSelect(settingsDecimalsSelect);
enhanceSelect(settingsSeparatorSelect);
enhanceSelect(settingsLanguageSelect);
enhanceSelect(settingsStakedSelect);
enhanceSelect(settingsWeekStartSelect);

settingsDecimalsSelect.addEventListener('change', () => {
  numberDecimals = Number(settingsDecimalsSelect.value);
  localStorage.setItem(NUMBER_DECIMALS_KEY, String(numberDecimals));
  refreshAllDisplays();
});

settingsSeparatorSelect.addEventListener('change', () => {
  decimalSeparatorStyle = VALID_SEPARATOR_STYLES.includes(settingsSeparatorSelect.value) ? settingsSeparatorSelect.value : 'period';
  localStorage.setItem(DECIMAL_SEPARATOR_KEY, decimalSeparatorStyle);
  refreshAllDisplays();
});

settingsStakedSelect.addEventListener('change', () => {
  mergeStakedPositions = settingsStakedSelect.value !== 'separate';
  localStorage.setItem(MERGE_STAKED_KEY, String(mergeStakedPositions));
  refreshAllDisplays();
});

settingsWeekStartSelect.addEventListener('change', () => {
  weekStart = settingsWeekStartSelect.value === 'sunday' ? 'sunday' : 'monday';
  localStorage.setItem(WEEK_START_KEY, weekStart);
  refreshAllDisplays();
});

settingsLanguageSelect.addEventListener('change', () => {
  applyLanguage(settingsLanguageSelect.value);
});

// The id of the account/manual coin currently shown as an inline edit form
// in the accounts list itself (rather than in the "Add account" panel) — at
// most one of these is non-null at a time, since only one row edits at once.
let editingAccountId = null;
let editingManualCryptoId = null;
let editingDateOnlyId = null;

// ── Crypto: address entry (live) or manual entry ────────────────────────────
// Pasting a wallet address is the default path; this toggle reveals a plain
// symbol/amount/value form right in the same section for anyone who'd rather
// enter one coin's position by hand.

const cryptoManualToggleBtn  = document.getElementById('crypto-manual-toggle-btn');
const cryptoManualForm       = document.getElementById('crypto-manual-form');
const cryptoManualNameInput  = document.getElementById('crypto-manual-name');
const manualCoinSymbolInput  = document.getElementById('manual-coin-symbol');
const manualCoinAmountInput  = document.getElementById('manual-coin-amount');
const manualCoinGeckoInput   = document.getElementById('manual-coingecko-url');
const cryptoManualBalanceInput = document.getElementById('crypto-manual-balance');

cryptoManualToggleBtn.addEventListener('click', () => {
  const nowHidden = cryptoManualForm.style.display !== 'none';
  cryptoManualForm.style.display = nowHidden ? 'none' : '';
  cryptoManualToggleBtn.textContent = nowHidden ? 'Enter values manually instead' : 'Hide manual entry';
});

async function submitCryptoManual() {
  const name = cryptoManualNameInput.value.trim();
  const symbol = manualCoinSymbolInput.value.trim().toUpperCase();
  // Plain text input (not <input type="number">) so arbitrarily many decimal
  // places are accepted — but that also means a comma decimal separator
  // (common outside en-US locales) has to be normalized by hand before
  // parsing, since Number() would otherwise just read it as NaN.
  const amount = Number(manualCoinAmountInput.value.trim().replace(',', '.'));
  const coinGeckoUrl = manualCoinGeckoInput.value.trim();
  const enteredValue = Number(cryptoManualBalanceInput.value);

  if (!symbol || !Number.isFinite(amount) || amount <= 0) {
    alert('Enter a coin symbol and a positive amount of coins.');
    return;
  }

  let value = enteredValue;
  let coinId = null;

  if (coinGeckoUrl) {
    try {
      const res = await fetch(`${API_BASE}/api/manual-price?url=${encodeURIComponent(coinGeckoUrl)}`);
      const data = await res.json();
      if (res.ok) {
        value = amount * data.price;
        coinId = data.coinId;
      } else if (!Number.isFinite(enteredValue)) {
        alert(`Couldn't get a price from that CoinGecko link (${data.error}). Enter a value manually instead.`);
        return;
      }
    } catch {
      if (!Number.isFinite(enteredValue)) {
        alert("Couldn't reach the price lookup. Enter a value manually instead.");
        return;
      }
    }
  }

  if (!Number.isFinite(value)) {
    alert('Enter a current value, or a CoinGecko link to look the price up automatically.');
    return;
  }

  manualCryptoPositions = [
    // `coinId` (when known) lets a future login refresh this position's value
    // against CoinGecko's current price instead of it going stale forever.
    { id: crypto.randomUUID(), symbol, name: name || symbol, amount, value, coinId },
    ...manualCryptoPositions
  ];
  saveManualCryptoPositions();
  syncProfileToServer();
  cryptoSnapshotUpdatedAt = new Date().toISOString();
  refreshCryptoPortfolioCard();
  cryptoManualForm.reset();
  cryptoManualForm.style.display = 'none';
  cryptoManualToggleBtn.textContent = 'Enter values manually instead';
}

cryptoManualForm.addEventListener('submit', (event) => {
  event.preventDefault();
  withLoading(submitCryptoManual);
});

// ── Crypto: log a sale (realized P&L) ───────────────────────────────────────
// Wallet activity can't reliably distinguish a real sale from a transfer to
// another wallet you own, a swap, or a staking deposit — so unlike Avanza's
// broker-confirmed sells, closed crypto trades are entered by hand here.

const cryptoSaleToggleBtn    = document.getElementById('crypto-sale-toggle-btn');
const cryptoSaleForm         = document.getElementById('crypto-sale-form');
const cryptoSaleSymbolInput  = document.getElementById('crypto-sale-symbol');
const cryptoSaleDateInput    = document.getElementById('crypto-sale-date');
const cryptoSaleQuantityInput = document.getElementById('crypto-sale-quantity');
const cryptoSaleBuyPriceInput = document.getElementById('crypto-sale-buy-price');
const cryptoSaleSellPriceInput = document.getElementById('crypto-sale-sell-price');

cryptoSaleToggleBtn.addEventListener('click', () => {
  const nowHidden = cryptoSaleForm.style.display !== 'none';
  cryptoSaleForm.style.display = nowHidden ? 'none' : '';
  cryptoSaleToggleBtn.textContent = nowHidden ? t('crypto.logSaleToggle') : 'Hide sale log';
});

function submitCryptoSale() {
  const symbol = cryptoSaleSymbolInput.value.trim().toUpperCase();
  const soldDate = cryptoSaleDateInput.value;
  // Same comma-decimal normalization as the manual-position amount field.
  const volume = Number(cryptoSaleQuantityInput.value.trim().replace(',', '.'));
  const buyPrice = Number(cryptoSaleBuyPriceInput.value);
  const sellPrice = Number(cryptoSaleSellPriceInput.value);

  if (!symbol || !soldDate || !Number.isFinite(volume) || volume <= 0) {
    alert('Enter a coin symbol, date sold, and a positive quantity sold.');
    return;
  }
  if (!Number.isFinite(buyPrice) || buyPrice < 0 || !Number.isFinite(sellPrice) || sellPrice < 0) {
    alert('Enter a valid buy price and sale price per coin.');
    return;
  }

  manualCryptoSales = [
    { id: crypto.randomUUID(), symbol, soldDate, volume, buyPrice, sellPrice },
    ...manualCryptoSales
  ];
  saveManualCryptoSales();
  syncProfileToServer();
  refreshCryptoPortfolioCard();
  cryptoSaleForm.reset();
  cryptoSaleForm.style.display = 'none';
  cryptoSaleToggleBtn.textContent = t('crypto.logSaleToggle');
}

cryptoSaleForm.addEventListener('submit', (event) => {
  event.preventDefault();
  withLoading(submitCryptoSale);
});

// ── Broker: BankID/password login (live) or manual entry ───────────────────
// Same idea as crypto — logging in connects live, but this toggle lets
// someone add a broker account as a flat name/ID/balance instead.

const brokerManualToggleBtn = document.getElementById('broker-manual-toggle-btn');
const brokerManualForm      = document.getElementById('broker-manual-form');

brokerManualToggleBtn.addEventListener('click', () => {
  const nowHidden = brokerManualForm.style.display !== 'none';
  brokerManualForm.style.display = nowHidden ? 'none' : '';
  brokerManualToggleBtn.textContent = nowHidden ? 'Enter account manually instead' : 'Hide manual entry';
});

brokerManualForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = document.getElementById('broker-manual-name').value.trim();
  const identifier = document.getElementById('broker-manual-id').value.trim();
  const balance = Number(document.getElementById('broker-manual-balance').value);
  if (!Number.isFinite(balance)) {
    alert('Enter a balance.');
    return;
  }

  const newAccount = {
    id: crypto.randomUUID(),
    type: 'broker',
    name,
    identifier,
    balance,
    positions: [],
    updatedAt: new Date().toISOString()
  };
  accounts = [newAccount, ...accounts];
  saveAccounts();
  syncProfileToServer();
  render();
  brokerManualForm.reset();
  brokerManualForm.style.display = 'none';
  brokerManualToggleBtn.textContent = 'Enter account manually instead';
});

// ── Flat account (bank, savings, investment, retirement, other) ────────────
// All five share one form — just a name + balance, no live data source or ID
// field — entered in whatever currency the portfolio is currently displaying
// (see the currency switcher above the total), converted to USD once here
// (same convention every manual account balance already follows) so it
// renders/totals correctly from then on. Which of the five it becomes comes
// straight from the type select at the top of the panel. Savings/investment/
// retirement accounts also carry an expected annual return, used to estimate
// an everyday return shown on the card (see estimateDailyReturn below).

const flatForm            = document.getElementById('flat-form');
const flatNameInput       = document.getElementById('flat-name');
const flatBalanceInput    = document.getElementById('flat-balance');
const flatBalanceCurrency = document.getElementById('flat-balance-currency');
const flatCurrencyNote    = document.getElementById('flat-currency-note');

// Keeps the "Balance (USD)" label and disclaimer note in sync with the
// portfolio's current display currency — called once at load and again
// whenever the currency switcher changes (see selectCurrency below).
function updateFlatCurrencyHint() {
  flatBalanceCurrency.textContent = displayCurrency;
  flatCurrencyNote.textContent = t('flat.currencyNote').replace('{currency}', displayCurrency);
}

flatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = flatNameInput.value.trim();
  const enteredBalance = Number(flatBalanceInput.value);
  if (!Number.isFinite(enteredBalance)) {
    alert('Enter a balance.');
    return;
  }

  const type = newAccountType.value;
  let annualReturn = null;
  if (ANNUAL_RETURN_TYPES.includes(type)) {
    const annualReturnRaw = flatAnnualReturnInput.value.trim();
    annualReturn = Number(annualReturnRaw);
    if (!annualReturnRaw || !Number.isFinite(annualReturn)) {
      alert('Enter an expected annual return.');
      return;
    }
  }

  // See the matching guard in the edit-save handler above — converting
  // against a not-yet-loaded rate would store the wrong balance.
  if (displayCurrency !== 'USD' && exchangeRates[displayCurrency] == null) {
    alert('Exchange rates are still loading — try again in a moment.');
    return;
  }

  const balance = convertToUSD(enteredBalance, displayCurrency);
  const newAccount = {
    id: crypto.randomUUID(),
    type,
    name,
    identifier: '',
    balance,
    annualReturn,
    positions: [],
    updatedAt: new Date().toISOString()
  };
  accounts = [newAccount, ...accounts];
  saveAccounts();
  syncProfileToServer();
  render();
  flatForm.reset();
});

// ── Expenses ─────────────────────────────────────────────────────────────────
// A separate everyday-spending tracker, unrelated to the portfolio accounts
// above beyond sharing the same display-currency conversion helpers. Each
// entry stores its amount in USD (same convention as manual accounts) so
// switching currency re-renders every total correctly without re-entry.
// "Other" is deliberately not part of the categorical color rotation — it's
// the fold-in bucket for anything that doesn't fit the other eight, so it
// gets a neutral, muted color rather than competing with them for identity.
const EXPENSE_CATEGORIES = [
  { value: 'groceries', color: '#3987e5' },
  { value: 'dining', color: '#008300' },
  { value: 'transport', color: '#d55181' },
  { value: 'housing', color: '#c98500' },
  { value: 'utilities', color: '#199e70' },
  { value: 'entertainment', color: '#d95926' },
  { value: 'health', color: '#9085e9' },
  { value: 'shopping', color: '#e66767' },
  { value: 'other', color: '#898781' }
];
// A separate category set for money coming in — sharing EXPENSE_CATEGORIES
// would mean "Groceries"/"Housing" etc. showing up as options for a salary
// deposit, so earnings get their own small list and color set instead.
const EARNING_CATEGORIES = [
  { value: 'salary', color: '#3987e5' },
  { value: 'freelance', color: '#199e70' },
  { value: 'gift', color: '#d55181' },
  { value: 'refund', color: '#c98500' },
  { value: 'investment', color: '#9085e9' },
  { value: 'other', color: '#898781' }
];

// User-added categories (see the "Manage categories" panel below the
// Category field) — a plain array like manualCryptoPositions/
// manualCryptoSales, each `{ id, value: id, type, label, color, custom: true }`.
// `value` just mirrors `id`; it exists so a custom category is a drop-in
// replacement for a built-in one everywhere `cat.value` is read (options,
// expense.category, map keys), without every call site needing a branch.
function loadCustomExpenseCategories() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_EXPENSE_CATEGORIES_KEY) || '[]');
  } catch {
    return [];
  }
}
function saveCustomExpenseCategories() {
  localStorage.setItem(CUSTOM_EXPENSE_CATEGORIES_KEY, JSON.stringify(customExpenseCategories));
}
let customExpenseCategories = loadCustomExpenseCategories();

// A built-in category can't be deleted (it's a code constant, not stored
// data) but can be hidden per user — same "hide, don't delete" idea as
// hiddenPositionIds for on-chain crypto positions. Keyed "type:value" since
// both category sets happen to use the value "other". "other" itself is
// never offered a hide button (see setupExpenseCategorySelect's renderMenu)
// — it's the fallback bucket every orphaned/hidden category's expenses
// fall into, so hiding it would break that fallback.
function loadHiddenExpenseCategories() {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_EXPENSE_CATEGORIES_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function saveHiddenExpenseCategories() {
  localStorage.setItem(HIDDEN_EXPENSE_CATEGORIES_KEY, JSON.stringify([...hiddenExpenseCategories]));
}
let hiddenExpenseCategories = loadHiddenExpenseCategories();

// A built-in category's color is a code constant (see EXPENSE_CATEGORIES/
// EARNING_CATEGORIES below) — this is where a per-user pick made via the
// swatch color picker (see showColorPickerRow) actually lives, keyed the
// same "type:value" way as hiddenExpenseCategories. Custom categories don't
// need an entry here at all — their color already lives directly on the
// category object, so the picker just writes into customExpenseCategories.
function loadCategoryColorOverrides() {
  try {
    return JSON.parse(localStorage.getItem(CATEGORY_COLOR_OVERRIDES_KEY) || '{}');
  } catch {
    return {};
  }
}
function saveCategoryColorOverrides() {
  localStorage.setItem(CATEGORY_COLOR_OVERRIDES_KEY, JSON.stringify(categoryColorOverrides));
}
let categoryColorOverrides = loadCategoryColorOverrides();

// New custom categories cycle through this palette by how many of that type
// already exist — distinct from the built-in colors above so a custom
// category is visually identifiable as "yours" at a glance.
const CUSTOM_CATEGORY_COLOR_PALETTE = ['#5b8def', '#c76b98', '#77b28c', '#e0a458', '#8577d1', '#4fb0c6', '#d97757', '#b0895c'];
function nextCustomCategoryColor(type) {
  const count = customExpenseCategories.filter((cat) => cat.type === type).length;
  return CUSTOM_CATEGORY_COLOR_PALETTE[count % CUSTOM_CATEGORY_COLOR_PALETTE.length];
}

// Picker offered when editing a custom category (see showEditCategoryRow) —
// only custom categories carry an `icon` field at all, so built-in ones
// (which have no editor) keep rendering as a plain color dot.
const EXPENSE_CATEGORY_ICONS = {
  cart: '<path d="M3 4h2l2.4 12.2a2 2 0 0 0 2 1.8h7.2a2 2 0 0 0 2-1.6L20 8H6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /><circle cx="10" cy="20" r="1.3" fill="currentColor" /><circle cx="17" cy="20" r="1.3" fill="currentColor" />',
  home: '<path d="M4 11l8-7 8 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /><path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /><path d="M10 20v-5h4v5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />',
  car: '<path d="M4 16V12l2-5h12l2 5v4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /><path d="M4 16h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /><circle cx="8" cy="17.5" r="1.5" fill="currentColor" /><circle cx="16" cy="17.5" r="1.5" fill="currentColor" />',
  utensils: '<path d="M8 3v8a2 2 0 1 1-4 0V3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /><path d="M6 11v10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /><path d="M16 3c-1.5 0-2.5 1.8-2.5 4s1 4 2.5 4v10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />',
  bolt: '<path d="M13 2 5 14h6l-1 8 8-12h-6l1-8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />',
  film: '<rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5" /><path d="M8 5v14M16 5v14M3 9h5M3 15h5M16 9h5M16 15h5" stroke="currentColor" stroke-width="1.3" />',
  heart: '<path d="M12 20.5s-7.5-4.6-9.6-9A5 5 0 0 1 12 6.8 5 5 0 0 1 21.6 11.5c-2.1 4.4-9.6 9-9.6 9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />',
  bag: '<path d="M6 8h12l1 12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L6 8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /><path d="M9 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />',
  gift: '<rect x="3" y="9" width="18" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5" /><path d="M3 13h18M12 9v12" stroke="currentColor" stroke-width="1.5" /><path d="M12 9C9 9 7.5 7.5 7.5 6a2.5 2.5 0 0 1 4.5-1.5C12 4.5 12 6 12 9ZM12 9c3 0 4.5-1.5 4.5-3a2.5 2.5 0 0 0-4.5-1.5C12 4.5 12 6 12 9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />',
  briefcase: '<rect x="3" y="8" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.5" /><path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="1.5" /><path d="M3 13h18" stroke="currentColor" stroke-width="1.5" />',
  coin: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" /><path d="M9.5 15c.5 1 1.4 1.5 2.5 1.5 1.7 0 3-1 3-2.2s-1-1.8-3-2.3-3-1.1-3-2.3 1.3-2.2 3-2.2c1.1 0 2 .5 2.5 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /><path d="M12 7v10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />',
  book: '<path d="M4 5a2 2 0 0 1 2-2h6v18H6a2 2 0 0 1-2-2V5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />'
};

// The visual (icon-on-tint, or a plain dot) shared by categorySwatchHtml
// and categorySwatchButtonHtml below — built-ins only ever have a color,
// custom categories additionally show whichever icon their editor set.
function categorySwatchInnerHtml(cat) {
  if (cat.icon && EXPENSE_CATEGORY_ICONS[cat.icon]) {
    return `
      <span class="expense-bar-swatch expense-bar-swatch-icon" style="color:${cat.color}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${EXPENSE_CATEGORY_ICONS[cat.icon]}</svg>
      </span>
    `;
  }
  return `<span class="expense-bar-swatch" style="background:${cat.color}"></span>`;
}

// The dot/icon shown next to a category everywhere it appears (dropdown,
// expense rows, breakdown bars/legend) — non-interactive; the dropdown row
// uses categorySwatchButtonHtml instead, which wraps the same visual in a
// button that opens the color picker (see showColorPickerRow).
function categorySwatchHtml(cat) {
  return categorySwatchInnerHtml(cat);
}

function categorySwatchButtonHtml(cat) {
  return `
    <button type="button" class="expense-category-swatch-btn" data-swatch-value="${cat.value}" title="${t('expenses.changeColorTitle')}">
      ${categorySwatchInnerHtml(cat)}
    </button>
  `;
}

// A fixed, hue-spread set of quick picks offered by the color picker (see
// showColorPickerRow) — separate from CUSTOM_CATEGORY_COLOR_PALETTE above,
// which is for auto-assigning a new custom category's initial color rather
// than for a user manually picking one.
const CATEGORY_COLOR_PRESETS = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635',
  '#34d399', '#2dd4bf', '#38bdf8', '#60a5fa',
  '#818cf8', '#c084fc', '#e879f9', '#f472b6'
];

function categoryIconGridHtml(selectedIcon) {
  return Object.keys(EXPENSE_CATEGORY_ICONS)
    .map((key) => `
      <button type="button" class="expense-category-icon-option${key === selectedIcon ? ' selected' : ''}" data-icon="${key}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${EXPENSE_CATEGORY_ICONS[key]}</svg>
      </button>
    `)
    .join('');
}

// Built-in categories minus any this user hid, plus their custom ones for
// this type — the single list every dropdown/map/legend/manager panel below
// is built from, so hiding or adding a category takes effect everywhere at
// once.
function categoriesForType(type) {
  const builtIn = (type === 'earning' ? EARNING_CATEGORIES : EXPENSE_CATEGORIES)
    .filter((cat) => !hiddenExpenseCategories.has(`${type}:${cat.value}`))
    .map((cat) => {
      const override = categoryColorOverrides[`${type}:${cat.value}`];
      return override ? { ...cat, color: override } : cat;
    });
  const custom = customExpenseCategories.filter((cat) => cat.type === type);
  return [...builtIn, ...custom];
}

function categoryMapForType(type) {
  return new Map(categoriesForType(type).map((cat) => [cat.value, cat]));
}

// Built-in category display names come from the current language rather
// than a static `label` field, so switching languages relabels the
// breakdown bars and entry list without needing its own re-render trigger.
// A custom category has no i18n key at all (it's a raw string the user
// typed), so it carries its own `label` instead and skips translation.
function categoryLabel(cat, type = 'expense') {
  if (cat.custom) return cat.label;
  const prefix = type === 'earning' ? 'earningCategory' : 'expenseCategory';
  return t(`${prefix}.${cat.value}`);
}

function loadExpenses() {
  try {
    return JSON.parse(localStorage.getItem(EXPENSES_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveExpenses() {
  localStorage.setItem(EXPENSES_KEY, JSON.stringify(expenses));
}

let expenses = loadExpenses();

// yyyy-mm-dd string helpers, kept local-time throughout — `new Date("yyyy-mm-dd")`
// parses as UTC midnight, which silently shifts a day backward in any
// negative-UTC-offset timezone, so every conversion here goes through
// getFullYear/getMonth/getDate instead of toISOString.
function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayLocalISODate() {
  return toISODate(new Date());
}

function parseISODateLocal(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const expenseForm            = document.getElementById('expense-form');
const expenseTypeButtons     = document.querySelectorAll('.expense-type-btn');
const expenseCategoryInput   = document.getElementById('expense-category');
const expenseDescriptionInput = document.getElementById('expense-description');
const expenseAmountInput     = document.getElementById('expense-amount');
const expenseAmountCurrency  = document.getElementById('expense-amount-currency');
const expenseDateTrigger     = document.getElementById('expense-date-trigger');
const expenseAccountSelect   = document.getElementById('expense-account');
const expensePeriodSelect    = document.getElementById('expense-period');
const expenseCustomRange     = document.getElementById('expense-custom-range');
const expenseRangeFromTrigger = document.getElementById('expense-range-from-trigger');
const expenseRangeToTrigger  = document.getElementById('expense-range-to-trigger');
const expenseViewButtons     = document.querySelectorAll('.expense-view-btn');
const expenseBreakdownFilterButtons = document.querySelectorAll('.expense-filter-btn');
const expenseBreakdownFilterToggle  = document.getElementById('expense-breakdown-filter-toggle');
const expenseTotalEl         = document.getElementById('expense-total');
const expenseEarnedEl        = document.getElementById('expense-earned');
const expenseNetEl           = document.getElementById('expense-net');
const expenseDailyAvgEl      = document.getElementById('expense-daily-avg');
const expenseEntryCountEl    = document.getElementById('expense-entry-count');
const expenseTopCategoryEl   = document.getElementById('expense-top-category');
const expenseBreakdownEl     = document.getElementById('expense-breakdown');
const expensesListEl         = document.getElementById('expenses-list');
const expenseEntriesSortSelect = document.getElementById('expense-entries-sort');
const expenseEntriesSubEl    = document.getElementById('expense-entries-sub');

// Same self-contained calendar popup used for a crypto position's "First
// Received" date (see the "Custom date picker" section below) — reused here
// verbatim instead of the native <input type="date">, so the Everyday
// Expenses page gets the identical month/year quick-jump, "today" highlight,
// and Clear-date behavior rather than a second, differently-styled picker.
function setDateTriggerValue(trigger, iso) {
  trigger.dataset.date = iso || '';
  trigger.querySelector('.edit-field-date-trigger-label').textContent = formatDatePickerDisplay(iso);
}

// Not called here: formatDatePickerDisplay (used inside setDateTriggerValue)
// reads DATE_PICKER_MONTHS, a const declared much further down in the
// "Custom date picker" section — calling it this early, before that
// declaration has run, throws a temporal-dead-zone ReferenceError. The
// initial "today" value is set later instead, right before the first
// render() call.
enhanceSelect(expensePeriodSelect);
enhanceSelect(expenseAccountSelect);
enhanceSelect(expenseEntriesSortSelect);

// Remembers whichever account was last picked in the "Add expense" form —
// so linking the same account every time (the common case: one everyday
// spending account) only has to be done once instead of on every single
// entry. Set on each submit (see expenseForm's submit handler) and applied
// as the fallback below whenever the field isn't already showing a live
// selection of its own.
let expenseDefaultAccountId = localStorage.getItem(EXPENSE_DEFAULT_ACCOUNT_KEY) || '';

// Options for the expense form's "Account" field — every manually-added
// account (bank/savings/investment/retirement/broker/other) that a balance
// could actually be deducted from or added to. 'wallet' accounts are the
// static demo/seed entries with no edit form of their own (see editId in
// manualAccountCardSpec) and live/synced accounts aren't manually-editable
// balances at all, so neither belongs here. Rebuilt (not just left alone)
// whenever the accounts list itself changes, via the call at the end of
// render() below, so a newly-added or renamed account shows up without a
// page reload.
function renderExpenseAccountOptions() {
  const previousValue = expenseAccountSelect.value;
  const linkable = accounts.filter((a) => a.type !== 'wallet');
  expenseAccountSelect.innerHTML = [
    `<option value="" data-i18n="expenses.accountNone">${t('expenses.accountNone')}</option>`,
    ...linkable.map((a) => `<option value="${a.id}">${a.name || t(`accountType.${a.type}`)} — ${t(`accountType.${a.type}`)}</option>`)
  ].join('');
  // Keep whatever was selected if that account still exists (e.g. a
  // re-render triggered by something unrelated mid-edit); otherwise fall
  // back to the remembered default account, so a freshly reset form still
  // shows it pre-selected rather than "None".
  if (linkable.some((a) => a.id === previousValue)) {
    expenseAccountSelect.value = previousValue;
  } else if (linkable.some((a) => a.id === expenseDefaultAccountId)) {
    expenseAccountSelect.value = expenseDefaultAccountId;
  }
  refreshCustomSelect(expenseAccountSelect);
}

// Which of the two category sets (EXPENSE_CATEGORIES / EARNING_CATEGORIES,
// see above) the "Add expense" form's Category field currently offers —
// driven by the Expense/Earning toggle below, not by any single entry's own
// type. Rebuilding the <option> list (rather than keeping both sets in the
// DOM and toggling visibility) keeps the custom-select dropdown in sync for
// free, since refreshCustomSelect just re-reads whatever options are present.
// A custom category's <option> deliberately gets no data-i18n attribute —
// the global language-switcher overwrites any element carrying one with
// t(that key) on every language change, which would blow away a custom
// label (no matching key exists) and show the literal key string instead.
function renderExpenseCategoryOptions(type) {
  const prefix = type === 'earning' ? 'earningCategory' : 'expenseCategory';
  expenseCategoryInput.innerHTML = categoriesForType(type)
    .map((cat) => {
      const i18nAttr = cat.custom ? '' : ` data-i18n="${prefix}.${cat.value}"`;
      return `<option value="${cat.value}"${i18nAttr}>${categoryLabel(cat, type)}</option>`;
    })
    .join('');
  refreshCustomSelect(expenseCategoryInput);
}

let expenseFormType = 'expense';

// A bespoke dropdown for the Category field — not the generic enhanceSelect
// used for every other <select> in the app, since this one needs a remove
// (×) button baked into each row (hide a built-in category, delete a custom
// one) plus an inline "add a custom category" row inside the popup itself,
// neither of which the shared widget's plain option-list rendering
// supports. Built by hand instead of extending enhanceSelect so every other
// select on the page (account type, period, ...) is untouched.
function setupExpenseCategorySelect() {
  expenseCategoryInput.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'custom-select-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `
    <span class="custom-select-label"></span>
    <svg class="dropdown-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
  const label = btn.querySelector('.custom-select-label');

  const menu = document.createElement('ul');
  menu.className = 'custom-select-menu expense-category-menu';
  menu.setAttribute('role', 'listbox');

  // Rebuilds the whole popup from scratch — registered below as this
  // select's refreshCustomSelect sync function too, so switching the
  // Expense/Earning toggle (which calls renderExpenseCategoryOptions, which
  // calls refreshCustomSelect) keeps this in step the same way it would for
  // a plain enhanceSelect-driven dropdown.
  function renderMenu() {
    const type = expenseFormType;
    const current = categoryMapForType(type).get(expenseCategoryInput.value);
    label.textContent = current ? categoryLabel(current, type) : '';

    const rowsHtml = categoriesForType(type)
      .map((cat) => {
        const selected = cat.value === expenseCategoryInput.value;
        // "Other" is the fallback every hidden/deleted category's existing
        // expenses fall back to (see categoryMapForType's callers) —
        // removing it would break that fallback, so it never gets a ×.
        const removeBtn = cat.value !== 'other'
          ? `<button type="button" class="expense-category-remove-btn" data-remove-value="${cat.value}" data-remove-custom="${cat.custom ? '1' : '0'}" title="${t('expenses.removeCategoryTitle')}">&times;</button>`
          : '';
        return `
          <li role="option" data-value="${cat.value}" class="expense-category-option${selected ? ' selected' : ''}" aria-selected="${selected}">
            ${categorySwatchHtml(cat)}
            <span class="expense-category-option-label">${categoryLabel(cat, type)}</span>
            ${removeBtn}
          </li>
        `;
      })
      .join('');

    menu.innerHTML = `${rowsHtml}<li class="expense-category-add-option">+ ${t('expenses.addCategoryBtn')}</li>`;
  }

  // Swaps the "+ Add" row for a name input, right inside the still-open
  // popup — confirming creates the category, selects it, and closes the
  // dropdown; Escape reverts back to the normal "+ Add" row.
  function showAddCategoryRow() {
    const addOption = menu.querySelector('.expense-category-add-option');
    if (!addOption) return;
    addOption.outerHTML = `
      <li class="expense-category-add-row-inline">
        <input type="text" class="expense-category-name-input" placeholder="${t('expenses.newCategoryPlaceholder')}" maxlength="40" />
        <button type="button" class="expense-category-confirm-add-btn" title="${t('expenses.addCategoryBtn')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M4 12.5l5 5L20 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </li>
    `;
    const input = menu.querySelector('.expense-category-add-row-inline .expense-category-name-input');
    input.focus();
    input.addEventListener('keydown', (event) => {
      // Stops Escape/Enter from also being caught by the document-level
      // "Escape closes every open custom-select" listener further up.
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); confirmAddCategory(); }
      else if (event.key === 'Escape') { event.preventDefault(); renderMenu(); }
    });
  }

  // Swaps a custom category's own row for a name input + icon grid, right
  // inside the still-open popup, the same way showAddCategoryRow swaps the
  // "+ Add" row. Built-in categories never get here — they have no editor
  // and clicking them still just selects them (see the click handler below).
  let editingCategoryId = null;
  let pendingEditIcon = null;

  function showEditCategoryRow(cat) {
    const li = menu.querySelector(`li[data-value="${cat.value}"]`);
    if (!li) return;
    editingCategoryId = cat.id;
    pendingEditIcon = cat.icon || null;
    li.outerHTML = `
      <li class="expense-category-edit-row-inline">
        <div class="expense-category-edit-top">
          <input type="text" class="expense-category-name-input" maxlength="40" />
          <button type="button" class="expense-category-confirm-edit-btn" title="${t('edit.saveChanges')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M4 12.5l5 5L20 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
        <div class="expense-category-icon-grid">${categoryIconGridHtml(pendingEditIcon)}</div>
      </li>
    `;
    const row = menu.querySelector('.expense-category-edit-row-inline');
    const input = row.querySelector('.expense-category-name-input');
    // Set as a property rather than an HTML attribute so a label containing
    // a `"` or `<` can't break out of the input markup above.
    input.value = cat.label;
    input.focus();
    input.select();
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); confirmEditCategory(); }
      else if (event.key === 'Escape') { event.preventDefault(); editingCategoryId = null; renderMenu(); }
    });
  }

  function confirmEditCategory() {
    const input = menu.querySelector('.expense-category-edit-row-inline .expense-category-name-input');
    const categoryName = input.value.trim();
    if (!categoryName) {
      alert('Enter a category name.');
      return;
    }
    const id = editingCategoryId;
    customExpenseCategories = customExpenseCategories.map((cat) =>
      cat.id === id ? { ...cat, label: categoryName, icon: pendingEditIcon } : cat
    );
    editingCategoryId = null;
    saveCustomExpenseCategories();
    syncProfileToServer();
    const type = expenseFormType;
    renderExpenseCategoryOptions(type);
    expenseCategoryInput.value = id;
    renderMenu();
    expenseCategoryInput.dispatchEvent(new Event('change', { bubbles: true }));
    wrapper.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }

  function confirmAddCategory() {
    const input = menu.querySelector('.expense-category-add-row-inline .expense-category-name-input');
    const categoryName = input.value.trim();
    if (!categoryName) {
      alert('Enter a category name.');
      return;
    }
    const id = crypto.randomUUID();
    const type = expenseFormType;
    customExpenseCategories = [
      ...customExpenseCategories,
      { id, value: id, type, label: categoryName, color: nextCustomCategoryColor(type), custom: true }
    ];
    saveCustomExpenseCategories();
    syncProfileToServer();
    // renderExpenseCategoryOptions rebuilds every <option> via innerHTML,
    // which resets .value to whatever the browser defaults an option-less
    // select to — so .value has to be set (and the popup/label explicitly
    // re-synced) *after* that rebuild, not before, or this selection would
    // silently get overwritten back to the first category in the list.
    renderExpenseCategoryOptions(type);
    expenseCategoryInput.value = id;
    renderMenu();
    expenseCategoryInput.dispatchEvent(new Event('change', { bubbles: true }));
    wrapper.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const opening = !wrapper.classList.contains('open');
    wrapper.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(opening));
    if (opening) renderMenu();
  });

  menu.addEventListener('click', (event) => {
    // Two defenses needed, not one: stopPropagation keeps this click's own
    // bubbling from reaching the document-level outside-click listener
    // below (relevant once a handler here replaces the clicked node via
    // outerHTML, which would otherwise leave a detached event.target by the
    // time it got there). preventDefault stops a *second*, independent
    // problem — the <select id="expense-category"> this popup replaces is
    // still wrapped in the same <label> (see index.html), and clicking any
    // plain, non-button descendant of a <label> (every <li> here) makes the
    // browser synthesize its own separate click directly on that hidden
    // select as the label's default click behavior. That synthetic click
    // bubbles on its own path straight to the document listener, which sees
    // a target outside `wrapper` (the select is a *sibling* of wrapper, not
    // a descendant) and closes the popup — immune to stopPropagation since
    // it's a different Event object entirely. preventDefault on the
    // original click suppresses that default action before it can fire.
    event.stopPropagation();
    event.preventDefault();
    const removeBtn = event.target.closest('.expense-category-remove-btn');
    if (removeBtn) {
      const value = removeBtn.dataset.removeValue;
      const isCustom = removeBtn.dataset.removeCustom === '1';
      const type = expenseFormType;
      if (isCustom) {
        if (!confirm('Delete this category? Existing expenses under it will show as "Other" instead.')) return;
        customExpenseCategories = customExpenseCategories.filter((cat) => cat.id !== value);
        saveCustomExpenseCategories();
        syncProfileToServer();
      } else {
        // Not a real delete (it's a code constant) — just hidden for this
        // user, same idea as hiddenPositionIds for on-chain crypto positions.
        hiddenExpenseCategories.add(`${type}:${value}`);
        saveHiddenExpenseCategories();
        syncProfileToServer();
      }
      // The category just removed might be the one currently selected —
      // fall back to "other" so the field never points at a value that no
      // longer exists in the list. Same ordering requirement as
      // confirmAddCategory: renderExpenseCategoryOptions's innerHTML rebuild
      // resets .value on its own, so the fallback has to happen *after* it,
      // then the popup/label explicitly re-synced.
      const wasSelected = expenseCategoryInput.value === value;
      renderExpenseCategoryOptions(type);
      if (wasSelected) {
        expenseCategoryInput.value = 'other';
        renderMenu();
        expenseCategoryInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      renderExpenses();
      return;
    }

    if (event.target.closest('.expense-category-add-option')) {
      showAddCategoryRow();
      return;
    }

    if (event.target.closest('.expense-category-confirm-add-btn')) {
      confirmAddCategory();
      return;
    }

    if (event.target.closest('.expense-category-confirm-edit-btn')) {
      confirmEditCategory();
      return;
    }

    const iconOption = event.target.closest('.expense-category-icon-option');
    if (iconOption) {
      pendingEditIcon = iconOption.dataset.icon;
      iconOption.parentElement.querySelectorAll('.expense-category-icon-option')
        .forEach((opt) => opt.classList.toggle('selected', opt === iconOption));
      return;
    }

    const li = event.target.closest('li[data-value]');
    if (!li) return;
    const type = expenseFormType;
    const cat = categoryMapForType(type).get(li.dataset.value);
    if (cat?.custom) {
      showEditCategoryRow(cat);
      return;
    }
    expenseCategoryInput.value = li.dataset.value;
    expenseCategoryInput.dispatchEvent(new Event('change', { bubbles: true }));
    renderMenu();
    wrapper.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(menu);
  expenseCategoryInput.insertAdjacentElement('afterend', wrapper);
  renderMenu();

  // Reuses the same outside-click/Escape-closes tracking every other
  // custom-select gets, and the same refreshCustomSelect hook
  // renderExpenseCategoryOptions already calls after rebuilding the native
  // <option> list.
  customSelectWrappers.add(wrapper);
  customSelectSyncFns.set(expenseCategoryInput, renderMenu);
}
setupExpenseCategorySelect();

function setExpenseFormType(type) {
  expenseFormType = type === 'earning' ? 'earning' : 'expense';
  expenseTypeButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.type === expenseFormType));
  renderExpenseCategoryOptions(expenseFormType);
}

expenseTypeButtons.forEach((btn) => btn.addEventListener('click', () => setExpenseFormType(btn.dataset.type)));
setExpenseFormType('expense');

// Persisted like every other display preference (currency, privacy mode,
// ...) — a page reload should keep showing the breakdown the way it was
// left, not silently reset to the default list view.
let expenseViewMode = localStorage.getItem(EXPENSE_VIEW_KEY);
if (!['list', 'wheel', 'calendar'].includes(expenseViewMode)) expenseViewMode = 'list';

// Which type the List/Wheel breakdown (the two "graph" views) shows — the
// rows and the % each row is computed against are restricted to just this
// type. Calendar view is unaffected — it already shows both types per day.
let expenseBreakdownFilter = localStorage.getItem(EXPENSE_BREAKDOWN_FILTER_KEY);
if (!['expense', 'earning'].includes(expenseBreakdownFilter)) expenseBreakdownFilter = 'expense';

// Whether the Entries list below the breakdown is one flat chronological
// list ('date', the original behavior) or split into one section per
// category ('category' — see renderExpenseEntriesByCategory).
let expenseEntriesSort = localStorage.getItem(EXPENSE_ENTRIES_SORT_KEY);
if (!['date', 'category'].includes(expenseEntriesSort)) expenseEntriesSort = 'date';

// The month currently shown in the calendar view — its own navigation (see
// the [data-cal-nav] listener below) stands in for the Period selector
// while this view is active (see getCalendarMonthBounds), rather than the
// two operating independently. Stays wherever the user left it for the rest
// of the session rather than jumping back to today on every render.
let expenseCalendarYear = new Date().getFullYear();
let expenseCalendarMonth = new Date().getMonth();

// The calendar has its own built-in period — whichever month it's currently
// showing (see getCalendarMonthBounds) — so the Period selector (This
// week/This month/Custom range) has no meaning there and is hidden rather
// than left on screen doing nothing.
function updateExpensePeriodControlsVisibility() {
  const hidden = expenseViewMode === 'calendar';
  // visibility (not display) on both the Period select and the breakdown
  // filter toggle — they still occupy their layout space while hidden, so
  // the List/Wheel/Calendar toggle sitting right after them never shifts
  // position when Calendar mode is entered/left (it stays put; only the
  // controls to its left appear/disappear in place).
  expensePeriodSelect.closest('.expense-period-select').style.visibility = hidden ? 'hidden' : '';
  if (hidden) expenseCustomRange.style.display = 'none';
  else expenseCustomRange.style.display = expensePeriodSelect.value === 'custom' ? '' : 'none';
  expenseBreakdownFilterToggle.style.visibility = hidden ? 'hidden' : '';
  expenseBreakdownFilterToggle.setAttribute('aria-hidden', String(hidden));
  expenseBreakdownFilterButtons.forEach((btn) => { btn.disabled = hidden; });
}

function setExpenseViewMode(mode) {
  expenseViewMode = mode;
  localStorage.setItem(EXPENSE_VIEW_KEY, expenseViewMode);
  expenseViewButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === expenseViewMode));
  updateExpensePeriodControlsVisibility();
  renderExpenses();
}

expenseViewButtons.forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.view === expenseViewMode);
  btn.addEventListener('click', () => setExpenseViewMode(btn.dataset.view));
});
updateExpensePeriodControlsVisibility();

function setExpenseBreakdownFilter(filter) {
  expenseBreakdownFilter = filter;
  localStorage.setItem(EXPENSE_BREAKDOWN_FILTER_KEY, expenseBreakdownFilter);
  expenseBreakdownFilterButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.filter === expenseBreakdownFilter));
  renderExpenses();
}

expenseBreakdownFilterButtons.forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.filter === expenseBreakdownFilter);
  btn.addEventListener('click', () => setExpenseBreakdownFilter(btn.dataset.filter));
});

expenseEntriesSortSelect.value = expenseEntriesSort;
expenseEntriesSortSelect.addEventListener('change', () => {
  expenseEntriesSort = expenseEntriesSortSelect.value === 'category' ? 'category' : 'date';
  localStorage.setItem(EXPENSE_ENTRIES_SORT_KEY, expenseEntriesSort);
  renderExpenses();
});

// Delegated once on the container itself (not the calendar markup, which is
// replaced wholesale on every render). A full renderExpenses() — not just a
// local re-render of the calendar fragment — since the stat cards and the
// entries list below are now scoped to whichever month the calendar is on
// too (see getCalendarMonthBounds), so navigating a month has to update
// those along with the grid itself.
expenseBreakdownEl.addEventListener('click', (event) => {
  const navBtn = event.target.closest('[data-cal-nav]');
  if (!navBtn) return;
  expenseCalendarMonth += Number(navBtn.dataset.calNav);
  if (expenseCalendarMonth < 0) { expenseCalendarMonth = 11; expenseCalendarYear--; }
  else if (expenseCalendarMonth > 11) { expenseCalendarMonth = 0; expenseCalendarYear++; }
  renderExpenses();
});

function updateExpenseCurrencyHint() {
  expenseAmountCurrency.textContent = displayCurrency;
}

expenseForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const category = expenseCategoryInput.value;
  const description = expenseDescriptionInput.value.trim();
  const enteredAmount = Number(expenseAmountInput.value);
  const date = expenseDateTrigger.dataset.date;

  if (!Number.isFinite(enteredAmount) || enteredAmount <= 0) {
    alert('Enter a positive amount.');
    return;
  }
  if (!date) {
    alert('Pick a date.');
    return;
  }

  const amount = convertToUSD(enteredAmount, displayCurrency);
  const accountId = expenseAccountSelect.value || null;
  // Remember whichever account (including "None") was just picked, so the
  // next entry defaults to it too instead of starting back at "None" —
  // see renderExpenseAccountOptions's fallback for where this gets applied.
  expenseDefaultAccountId = accountId || '';
  localStorage.setItem(EXPENSE_DEFAULT_ACCOUNT_KEY, expenseDefaultAccountId);
  expenses = [
    { id: crypto.randomUUID(), type: expenseFormType, category, description, amount, date, accountId, createdAt: new Date().toISOString() },
    ...expenses
  ];
  saveExpenses();
  if (accountId) {
    // An earning adds to the account's balance, an expense deducts from it —
    // same sign convention as totalEarned/totalSpent above. render() picks up
    // the new balance (and recomputed daily-return estimate, see
    // estimateDailyReturn) since both are derived fresh from account.balance
    // on every call, not cached anywhere.
    applyAccountBalanceDelta(accountId, expenseFormType === 'earning' ? amount : -amount);
    render();
  }
  syncProfileToServer();
  expenseForm.reset();
  setDateTriggerValue(expenseDateTrigger, todayLocalISODate());
  // form.reset() doesn't touch the type toggle (its buttons aren't native
  // form controls) or resync the category dropdown on its own — back to
  // Expense/its category list for the next entry, same as every other field
  // resetting to its default.
  setExpenseFormType('expense');
  // form.reset() also drops the Account field back to native "None" —
  // renderExpenseAccountOptions re-applies expenseDefaultAccountId instead
  // of just refreshCustomSelect's plain visual re-sync, so the account just
  // used stays selected for the next entry.
  renderExpenseAccountOptions();
  renderExpenses();
});

expensePeriodSelect.addEventListener('change', () => {
  expenseCustomRange.style.display = expensePeriodSelect.value === 'custom' ? '' : 'none';
  renderExpenses();
});

// The date triggers open the shared calendar popup (see accountsList's
// listener below and openDatePicker/selectDatePickerDate further down) —
// picking a day there closes the popup and re-renders expenses itself, so
// there's no 'change' event to listen for here the way the native
// <input type="date"> used to fire one.
pageExpenses.addEventListener('click', (event) => {
  const dateTrigger = event.target.closest('.edit-field-date-trigger');
  if (dateTrigger) openDatePicker(dateTrigger);
});

// Returns the [start, end] yyyy-mm-dd bounds (inclusive) of the currently
// selected period, or [null, null] for "all time" — a null bound means
// unbounded on that side, checked by isExpenseWithinPeriod below.
function getSelectedExpensePeriod() {
  const today = parseISODateLocal(todayLocalISODate());
  const period = expensePeriodSelect.value;

  if (period === 'week') {
    // Monday-start week containing today.
    const isoDayIndex = (today.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
    const start = new Date(today);
    start.setDate(today.getDate() - isoDayIndex);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return [toISODate(start), toISODate(end)];
  }
  if (period === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return [toISODate(start), toISODate(end)];
  }
  if (period === 'custom') {
    return [expenseRangeFromTrigger.dataset.date || null, expenseRangeToTrigger.dataset.date || null];
  }
  return [null, null];
}

// Same [start, end] shape as getSelectedExpensePeriod, but for whichever
// month the Calendar view is currently showing (expenseCalendarYear/Month)
// — the calendar's own prev/next navigation acts as its period, standing in
// for the (hidden, in that view) Period selector.
function getCalendarMonthBounds() {
  const start = new Date(expenseCalendarYear, expenseCalendarMonth, 1);
  const end = new Date(expenseCalendarYear, expenseCalendarMonth + 1, 0);
  return [toISODate(start), toISODate(end)];
}

function isExpenseWithinPeriod(dateStr, start, end) {
  if (start && dateStr < start) return false;
  if (end && dateStr > end) return false;
  return true;
}

// Number of days the stats should be averaged over: the period's own span
// when both bounds are known, otherwise the span actually covered by the
// filtered entries themselves (earliest entry through today) — covers both
// "all time" and a custom range left partly open.
function expenseDayCount(periodExpenses, start, end) {
  if (start && end) {
    return Math.round((parseISODateLocal(end) - parseISODateLocal(start)) / 86400000) + 1;
  }
  if (!periodExpenses.length) return 0;
  const earliest = periodExpenses.reduce((min, e) => (e.date < min ? e.date : min), periodExpenses[0].date);
  const today = parseISODateLocal(todayLocalISODate());
  return Math.round((today - parseISODateLocal(earliest)) / 86400000) + 1;
}

// Runs a callback two animation frames from now instead of one — a single
// rAF can still land before the browser has painted the just-inserted
// elements at their starting state (width:0 / an empty dash), so the jump
// straight to the target value happens with no transition at all. Waiting a
// full extra frame guarantees that first paint has already happened.
function afterNextPaint(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

// The original horizontal-bar-list layout — one row per category, bar width
// proportional to its share of the period total. Each fill starts at 0%
// (see animateExpenseList) and each row fades/slides in with a small
// stagger, so a fresh render reads as the bars filling up rather than
// popping in fully formed.
function renderExpenseList(rows, total) {
  return rows
    .map((row, index) => {
      const pct = total > 0 ? (row.amount / total) * 100 : 0;
      const sign = row.type === 'earning' ? '+' : '';
      const amountLabel = `${sign}${fmtCurrency(row.amount, 'USD')}`;
      const label = categoryLabel(row, row.type);
      return `
        <div class="expense-bar-row" style="animation-delay:${index * 55}ms">
          <div class="expense-bar-label">
            ${categorySwatchHtml(row)}
            <span>${label}</span>
          </div>
          <div class="expense-bar-track" title="${label}: ${amountLabel} (${pct.toFixed(1)}%)">
            <div class="expense-bar-fill" data-target-width="${pct}" style="width:0%; background:${row.color}"></div>
          </div>
          <div class="expense-bar-amount ${row.type === 'earning' ? 'gain' : ''}">${amountLabel} <span class="expense-bar-pct">${pct.toFixed(0)}%</span></div>
        </div>
      `;
    })
    .join('');
}

function animateExpenseList() {
  const fills = expenseBreakdownEl.querySelectorAll('.expense-bar-fill[data-target-width]');
  afterNextPaint(() => {
    fills.forEach((el) => { el.style.width = `${el.dataset.targetWidth}%`; });
  });
}

// Donut chart built from stacked SVG circle strokes — each category gets an
// arc-length share of the ring's circumference proportional to its share of
// the total, offset by every earlier segment's cumulative length so they
// tile around the ring with no gaps or overlaps. The whole ring is rotated
// -90deg so the first segment starts at 12 o'clock (SVG's own zero-angle is
// 3 o'clock) instead of computing that rotation into every dash offset.
// Every segment starts as a zero-length arc (see animateExpenseWheel) and
// grows into place with a per-segment delay, so the ring sweeps itself full
// one category at a time instead of appearing already complete.
function renderExpenseWheel(rows, total) {
  const size = 160;
  const radius = 62;
  const strokeWidth = 26;
  const circumference = 2 * Math.PI * radius;

  let cumulative = 0;
  const segments = rows
    .map((row, index) => {
      const share = total > 0 ? row.amount / total : 0;
      const dash = share * circumference;
      const gap = circumference - dash;
      const circle = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${row.color}" stroke-width="${strokeWidth}" stroke-dasharray="0 ${circumference}" stroke-dashoffset="${-cumulative}" data-target-dash="${dash}" data-target-gap="${gap}" style="transition-delay:${index * 110}ms" />`;
      cumulative += dash;
      return circle;
    })
    .join('');

  const legend = rows
    .map((row, index) => {
      const pct = total > 0 ? (row.amount / total) * 100 : 0;
      const sign = row.type === 'earning' ? '+' : '';
      const amountLabel = `${sign}${fmtCurrency(row.amount, 'USD')}`;
      const label = categoryLabel(row, row.type);
      return `
        <div class="expense-wheel-legend-row" style="animation-delay:${index * 55 + 150}ms">
          ${categorySwatchHtml(row)}
          <span class="expense-wheel-legend-label">${label}</span>
          <span class="expense-wheel-legend-amount ${row.type === 'earning' ? 'gain' : ''}">${amountLabel} <span class="expense-bar-pct">${pct.toFixed(0)}%</span></span>
        </div>
      `;
    })
    .join('');

  return `
    <div class="expense-wheel-wrap">
      <div class="expense-wheel-svg-wrap">
        <svg viewBox="0 0 ${size} ${size}" class="expense-wheel">
          <g transform="rotate(-90 ${size / 2} ${size / 2})">${segments}</g>
        </svg>
        <div class="expense-wheel-center">
          <span class="expense-wheel-center-amount">${fmtCurrency(total, 'USD')}</span>
          <span class="expense-wheel-center-label">${t('expenses.totalActivity')}</span>
        </div>
      </div>
      <div class="expense-wheel-legend">${legend}</div>
    </div>
  `;
}

function animateExpenseWheel() {
  const circles = expenseBreakdownEl.querySelectorAll('.expense-wheel circle[data-target-dash]');
  afterNextPaint(() => {
    circles.forEach((c) => {
      c.setAttribute('stroke-dasharray', `${c.dataset.targetDash} ${c.dataset.targetGap}`);
    });
  });
}

// DATE_PICKER_WEEKDAYS (see the "Custom date picker" section below) is
// already Sunday-first (['Su','Mo',...,'Sa']) — reused here as-is for a
// Sunday-start week, or rotated by one for a Monday-start week, so the
// calendar's weekday labels never fall out of sync with the ones the date
// picker already uses elsewhere.
function calendarWeekdayLabels() {
  if (weekStart === 'sunday') return DATE_PICKER_WEEKDAYS;
  return [...DATE_PICKER_WEEKDAYS.slice(1), DATE_PICKER_WEEKDAYS[0]];
}

// Maps JS's native Sunday=0..Saturday=6 into a 0-based column index under
// the current week-start setting, so the same month-grid-building code
// works for either start day.
function calendarColumnIndex(jsDay) {
  return weekStart === 'sunday' ? jsDay : (jsDay + 6) % 7;
}

// A full month grid for the Expenses page's Calendar view — every day cell
// shows that day's net (earned minus spent) across *all* saved expenses.
// Also builds a net total per week (shown in a trailing 8th column) and for
// the month as a whole (shown next to the month/year title) — this is now
// the effective "period" for this view (see getCalendarMonthBounds), so
// these totals always match what the stat cards above are showing.
// Navigated via its own prev/next month buttons (see the [data-cal-nav]
// listener above), independent of everything else on the page.
function renderExpenseCalendar() {
  const year = expenseCalendarYear;
  const month = expenseCalendarMonth;
  const monthStr = String(month + 1).padStart(2, '0');
  const prefix = `${year}-${monthStr}-`;

  const daySums = new Map();
  let monthSpent = 0;
  let monthEarned = 0;
  for (const e of expenses) {
    if (!e.date.startsWith(prefix)) continue;
    const day = Number(e.date.slice(8, 10));
    const sums = daySums.get(day) || { spent: 0, earned: 0 };
    if (e.type === 'earning') { sums.earned += e.amount; monthEarned += e.amount; }
    else { sums.spent += e.amount; monthSpent += e.amount; }
    daySums.set(day, sums);
  }

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstCol = calendarColumnIndex(new Date(year, month, 1).getDay());
  const todayIso = todayLocalISODate();

  // One flat list of day numbers, with a leading/trailing `null` for each
  // blank cell, padded to a multiple of 7 so it splits evenly into whole
  // weeks — each chunk of 7 becomes one row, with its own net total tacked
  // on as an 8th item (see the loop below).
  const dayList = [];
  for (let i = 0; i < firstCol; i++) dayList.push(null);
  for (let day = 1; day <= daysInMonth; day++) dayList.push(day);
  while (dayList.length % 7 !== 0) dayList.push(null);

  let cells = '';
  for (let weekStartIdx = 0; weekStartIdx < dayList.length; weekStartIdx += 7) {
    let weekSpent = 0;
    let weekEarned = 0;
    for (const day of dayList.slice(weekStartIdx, weekStartIdx + 7)) {
      if (day == null) {
        cells += `<div class="expense-calendar-day expense-calendar-day-empty"></div>`;
        continue;
      }
      const iso = `${year}-${monthStr}-${String(day).padStart(2, '0')}`;
      const sums = daySums.get(day);
      const classes = ['expense-calendar-day'];
      if (iso === todayIso) classes.push('today');
      let amountHtml = '';
      if (sums) {
        classes.push('has-activity');
        weekSpent += sums.spent;
        weekEarned += sums.earned;
        const net = sums.earned - sums.spent;
        const amountLabel = `${net >= 0 ? '+' : ''}${fmtCurrency(net, 'USD')}`;
        amountHtml = `<span class="expense-calendar-day-amount ${gainClass(net)}">${amountLabel}</span>`;
      }
      cells += `
        <div class="${classes.join(' ')}" style="animation-delay:${day * 10}ms">
          <span class="expense-calendar-day-number">${day}</span>
          ${amountHtml}
        </div>
      `;
    }

    const weekHasActivity = weekSpent > 0 || weekEarned > 0;
    const weekNet = weekEarned - weekSpent;
    const weekTotalLabel = weekHasActivity ? `${weekNet >= 0 ? '+' : ''}${fmtCurrency(weekNet, 'USD')}` : '—';
    const weekTotalClass = weekHasActivity ? gainClass(weekNet) : 'expense-calendar-week-total-empty';
    cells += `<div class="expense-calendar-week-total ${weekTotalClass}">${weekTotalLabel}</div>`;
  }

  const monthNet = monthEarned - monthSpent;
  const monthTotalLabel = `${monthNet >= 0 ? '+' : ''}${fmtCurrency(monthNet, 'USD')}`;

  return `
    <div class="expense-calendar">
      <div class="expense-calendar-header">
        <button type="button" class="expense-calendar-nav" data-cal-nav="-1" title="Previous month">&#8249;</button>
        <div class="expense-calendar-title-wrap">
          <span class="expense-calendar-title">${DATE_PICKER_MONTHS[month]} ${year}</span>
          <span class="expense-calendar-month-total ${gainClass(monthNet)}">${monthTotalLabel}</span>
        </div>
        <button type="button" class="expense-calendar-nav" data-cal-nav="1" title="Next month">&#8250;</button>
      </div>
      <div class="expense-calendar-weekdays">${calendarWeekdayLabels().map((w) => `<span>${w}</span>`).join('')}<span>${t('expenses.weekTotalLabel')}</span></div>
      <div class="expense-calendar-grid">${cells}</div>
    </div>
  `;
}

// Expense and earning categories together in one breakdown — keyed by
// "type:value" so a same-valued category shared between the two type's
// lists (built-in "other" exists in both) doesn't merge two unrelated
// categories' totals into one row.
function renderExpenseBreakdown(periodExpenses, total) {
  const totals = new Map();
  for (const e of periodExpenses) {
    const type = e.type === 'earning' ? 'earning' : 'expense';
    const catMap = categoryMapForType(type);
    // An expense whose category was since hidden or deleted (custom
    // category removed) isn't in catMap anymore — fold it into "Other"
    // rather than dropping its amount from the breakdown entirely, same
    // fallback renderExpenseEntries/the linked-expenses widget already use.
    const value = catMap.has(e.category) ? e.category : 'other';
    const key = `${type}:${value}`;
    totals.set(key, (totals.get(key) || 0) + e.amount);
  }

  const taggedCategories = (type) => categoriesForType(type).map((cat) => ({ ...cat, type }));
  const rows = [...taggedCategories('expense'), ...taggedCategories('earning')]
    .map((cat) => ({ ...cat, amount: totals.get(`${cat.type}:${cat.value}`) || 0 }))
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  expenseTopCategoryEl.textContent = rows.length ? categoryLabel(rows[0], rows[0].type) : '—';

  if (expenseViewMode === 'calendar') {
    expenseBreakdownEl.innerHTML = renderExpenseCalendar();
    return;
  }

  if (!rows.length) {
    expenseBreakdownEl.innerHTML = `<p class="avanza-note">${t('emptyState.noExpenseBreakdown')}</p>`;
    return;
  }

  if (expenseViewMode === 'wheel') {
    expenseBreakdownEl.innerHTML = renderExpenseWheel(rows, total);
    animateExpenseWheel();
  } else {
    expenseBreakdownEl.innerHTML = renderExpenseList(rows, total);
    animateExpenseList();
  }
}

// Entries saved before the Expense/Earning toggle existed have no `type`
// field at all — treat those as expenses, same as they always implicitly
// were. Shared by both the flat list and the per-category grouping below.
function expenseEntryTypeAndCategory(e) {
  const type = e.type === 'earning' ? 'earning' : 'expense';
  const catMap = categoryMapForType(type);
  const cat = catMap.get(e.category) || catMap.get('other');
  return { type, cat };
}

function renderExpenseEntryCard(e) {
  const { type, cat } = expenseEntryTypeAndCategory(e);
  const label = categoryLabel(cat, type);
  const dateLabel = parseISODateLocal(e.date).toLocaleDateString('en-US', { dateStyle: 'medium' });
  const amountLabel = `${type === 'earning' ? '+' : ''}${formatCurrency(e.amount)}`;
  return `
    <article class="account-card" data-expense-id="${e.id}">
      <div class="expense-entry-row">
        ${categorySwatchHtml(cat)}
        <div class="expense-entry-main">
          <h3>${e.description || label}</h3>
          <div class="meta">${label} &middot; ${dateLabel}</div>
        </div>
        <span class="account-card-value ${type === 'earning' ? 'gain' : ''}">${amountLabel}</span>
        <button class="remove-btn" data-expense-id="${e.id}" title="${t('expenses.removeTitle')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </article>
  `;
}

const sortEntriesByDateDesc = (list) => [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

// One section per category — across both expense and earning types at
// once, keyed by "type:category" so a same-valued category id shared
// between the two type's lists (built-in "other" exists in both) doesn't
// merge two unrelated groups into one. Sections are ordered by their own
// total (largest first), matching how the List/Wheel breakdown above
// orders categories; entries within a section stay newest-first.
function renderExpenseEntriesByCategory(periodExpenses) {
  const groups = new Map();
  for (const e of periodExpenses) {
    const { type, cat } = expenseEntryTypeAndCategory(e);
    const key = `${type}:${cat.value}`;
    if (!groups.has(key)) groups.set(key, { type, cat, entries: [], total: 0 });
    const group = groups.get(key);
    group.entries.push(e);
    group.total += e.amount;
  }

  return [...groups.values()]
    .sort((a, b) => b.total - a.total)
    .map((group) => {
      const label = categoryLabel(group.cat, group.type);
      const totalLabel = `${group.type === 'earning' ? '+' : ''}${formatCurrency(group.total)}`;
      const entriesHtml = sortEntriesByDateDesc(group.entries).map(renderExpenseEntryCard).join('');
      return `
        <div class="expense-entries-group">
          <div class="expense-entries-group-heading">
            ${categorySwatchHtml(group.cat)}
            <span class="expense-entries-group-label">${label}</span>
            <span class="expense-entries-group-count">${group.entries.length}</span>
            <span class="expense-entries-group-total ${group.type === 'earning' ? 'gain' : ''}">${totalLabel}</span>
          </div>
          <div class="expense-entries-group-list">${entriesHtml}</div>
        </div>
      `;
    })
    .join('');
}

function renderExpenseEntries(periodExpenses) {
  expenseEntriesSubEl.textContent = t(
    expenseEntriesSort === 'category' ? 'expenses.entriesSubByCategory' : 'expenses.entriesSub'
  );

  if (!periodExpenses.length) {
    expensesListEl.innerHTML = `<p class="empty-state">${t('emptyState.noExpenses')}</p>`;
    return;
  }

  expensesListEl.innerHTML = expenseEntriesSort === 'category'
    ? renderExpenseEntriesByCategory(periodExpenses)
    : sortEntriesByDateDesc(periodExpenses).map(renderExpenseEntryCard).join('');
}

function renderExpenses() {
  updateExpenseCurrencyHint();

  // The Calendar view has its own period — whichever month it's currently
  // showing — instead of the (hidden, in that view) Period selector, so the
  // stat cards and entries list below stay in sync with the month you're
  // actually looking at rather than a leftover List/Wheel period selection.
  const [start, end] = expenseViewMode === 'calendar' ? getCalendarMonthBounds() : getSelectedExpensePeriod();
  const periodEntries = expenses.filter((e) => isExpenseWithinPeriod(e.date, start, end));
  // Entries saved before the Expense/Earning toggle existed have no `type`
  // field — those are all pre-existing expenses, so only an explicit
  // 'earning' counts as one; everything else falls back to expense.
  const expenseEntries = periodEntries.filter((e) => e.type !== 'earning');
  const earningEntries = periodEntries.filter((e) => e.type === 'earning');

  const totalSpent = expenseEntries.reduce((sum, e) => sum + e.amount, 0);
  const totalEarned = earningEntries.reduce((sum, e) => sum + e.amount, 0);
  const net = totalEarned - totalSpent;
  // Daily average stays scoped to spending, same meaning it's always had —
  // regardless of which type the category breakdown below is showing.
  const dayCount = expenseDayCount(expenseEntries, start, end);

  expenseTotalEl.textContent = fmtCurrency(totalSpent, 'USD');
  expenseEarnedEl.textContent = fmtCurrency(totalEarned, 'USD');
  expenseNetEl.textContent = `${net >= 0 ? '+' : ''}${fmtCurrency(net, 'USD')}`;
  expenseNetEl.className = `stat-value ${gainClass(net)}`;
  expenseDailyAvgEl.textContent = fmtCurrency(dayCount > 0 ? totalSpent / dayCount : 0, 'USD');
  expenseEntryCountEl.textContent = String(periodEntries.length);

  // List/Wheel (see renderExpenseBreakdown) always show one type at a time —
  // the total passed in has to narrow to that same type, since it's the
  // denominator each row's own percentage share is computed against.
  const breakdownEntries = periodEntries.filter((e) => (e.type === 'earning' ? 'earning' : 'expense') === expenseBreakdownFilter);
  const breakdownTotal = expenseBreakdownFilter === 'earning' ? totalEarned : totalSpent;
  renderExpenseBreakdown(breakdownEntries, breakdownTotal);
  // The Entries list below follows the same Expenses/Earnings filter as the
  // graphs above it — except in Calendar mode, where that filter is hidden
  // (it doesn't apply to the calendar grid), so Entries there stays
  // unfiltered, same as it's always been.
  renderExpenseEntries(expenseViewMode === 'calendar' ? periodEntries : breakdownEntries);
}

expensesListEl.addEventListener('click', (event) => {
  const removeBtn = event.target.closest('.remove-btn[data-expense-id]');
  if (!removeBtn) return;
  const removedEntry = expenses.find((e) => e.id === removeBtn.dataset.expenseId);
  expenses = expenses.filter((e) => e.id !== removeBtn.dataset.expenseId);
  saveExpenses();
  if (removedEntry?.accountId) {
    // Undo the balance adjustment this entry made when it was added — the
    // exact inverse of the submit handler's delta, so deleting a linked
    // expense/earning doesn't leave the account's balance permanently
    // shifted by an entry that no longer exists.
    applyAccountBalanceDelta(removedEntry.accountId, removedEntry.type === 'earning' ? -removedEntry.amount : removedEntry.amount);
    render();
  }
  syncProfileToServer();
  renderExpenses();
});

accountsList.addEventListener('click', (event) => {
  const dateTrigger = event.target.closest('.edit-field-date-trigger');
  if (dateTrigger) {
    openDatePicker(dateTrigger);
    return;
  }

  // Editing happens inline, right where the account/position already sits in
  // the list — the pencil just flips that one row into its edit form; it
  // doesn't touch the "Add account" panel at all.
  const editAccountBtn = event.target.closest('.edit-btn[data-edit-id]');
  if (editAccountBtn) {
    editingManualCryptoId = null;
    editingDateOnlyId = null;
    editingAccountId = editAccountBtn.dataset.editId;
    render();
    return;
  }

  const editManualPositionBtn = event.target.closest('.position-edit-btn[data-edit-manual-id]');
  if (editManualPositionBtn) {
    editingAccountId = null;
    editingDateOnlyId = null;
    editingManualCryptoId = editManualPositionBtn.dataset.editManualId;
    expandedIds.add('crypto-portfolio');
    refreshCryptoPortfolioCard();
    return;
  }

  // "Set date" — offered only on a wallet-derived position the chain
  // couldn't determine a first-received date for at all (see getDateEditId).
  const setDateBtn = event.target.closest('.set-date-btn[data-position-id]');
  if (setDateBtn) {
    editingAccountId = null;
    editingManualCryptoId = null;
    editingDateOnlyId = setDateBtn.dataset.positionId;
    expandedIds.add('crypto-portfolio');
    refreshCryptoPortfolioCard();
    return;
  }

  const cancelAccountEditBtn = event.target.closest('.cancel-account-edit-btn');
  if (cancelAccountEditBtn) {
    editingAccountId = null;
    render();
    return;
  }

  const cancelCryptoEditBtn = event.target.closest('.cancel-crypto-edit-btn');
  if (cancelCryptoEditBtn) {
    closeDatePicker();
    editingManualCryptoId = null;
    refreshCryptoPortfolioCard();
    return;
  }

  const cancelDateEditBtn = event.target.closest('.cancel-date-edit-btn');
  if (cancelDateEditBtn) {
    closeDatePicker();
    editingDateOnlyId = null;
    refreshCryptoPortfolioCard();
    return;
  }

  const saveAccountEditBtn = event.target.closest('.save-account-edit-btn[data-account-id]');
  if (saveAccountEditBtn) {
    const card = saveAccountEditBtn.closest('.account-card-edit');
    const name = card.querySelector('.edit-field-name').value.trim();
    const type = card.querySelector('.edit-field-type').value;
    const identifier = card.querySelector('.edit-field-identifier')?.value.trim() || '';
    const enteredBalance = Number(card.querySelector('.edit-field-balance').value);

    if (!Number.isFinite(enteredBalance)) {
      alert('Enter a balance.');
      return;
    }

    // Both convertToDisplayCurrency (rendering this field) and convertToUSD
    // (below) silently skip conversion when a currency's rate isn't loaded
    // yet, so each is individually safe. But if the rate finishes loading in
    // between — the field was rendered before loadExchangeRates() resolved,
    // and this save fires after — the field shows a raw USD number mislabeled
    // as displayCurrency, then gets divided by the now-known rate here,
    // silently shrinking the stored balance. Bail out instead of saving a
    // wrong number.
    if (displayCurrency !== 'USD' && exchangeRates[displayCurrency] == null) {
      alert('Exchange rates are still loading — try saving again in a moment.');
      return;
    }

    // The field above is shown (and entered) in the current display currency,
    // but `accounts` always stores balance in USD (see convertToUSD) — same
    // conversion the "Add account" flat-form does on submit. Skipping this
    // here previously saved the raw display-currency number as if it were
    // already USD, silently shrinking (or inflating) the stored balance every
    // time an account was edited while displayCurrency wasn't USD.
    const balance = convertToUSD(enteredBalance, displayCurrency);

    let annualReturn = null;
    if (ANNUAL_RETURN_TYPES.includes(type)) {
      const annualReturnRaw = card.querySelector('.edit-field-annual-return').value.trim();
      annualReturn = Number(annualReturnRaw);
      if (!annualReturnRaw || !Number.isFinite(annualReturn)) {
        alert('Enter an expected annual return.');
        return;
      }
    }

    const accountId = saveAccountEditBtn.dataset.accountId;
    accounts = accounts.map((a) => (a.id === accountId ? { ...a, type, name, identifier, balance, annualReturn, positions: scalePositionsToBalance(a.positions, a.balance, balance), updatedAt: new Date().toISOString() } : a));
    saveAccounts();
    syncProfileToServer();
    editingAccountId = null;
    render();
    return;
  }

  const saveCryptoEditBtn = event.target.closest('.save-crypto-edit-btn[data-manual-id]');
  if (saveCryptoEditBtn) {
    const row = saveCryptoEditBtn.closest('.position-row-editing');
    const name = row.querySelector('.edit-field-name').value.trim();
    const symbol = row.querySelector('.edit-field-symbol').value.trim().toUpperCase();
    const amount = Number(row.querySelector('.edit-field-amount').value.trim().replace(',', '.'));
    const firstReceivedDate = row.querySelector('.edit-field-date-trigger').dataset.date || null;
    const coinGeckoUrl = row.querySelector('.edit-field-coingecko-url').value.trim();
    const manualPurchasePrice = Number(row.querySelector('.edit-field-purchase-price')?.value);

    if (!symbol || !Number.isFinite(amount) || amount <= 0) {
      alert('Enter a coin symbol and a positive amount of coins.');
      return;
    }

    closeDatePicker();
    const manualId = saveCryptoEditBtn.dataset.manualId;
    const existing = manualCryptoPositions.find((m) => m.id === manualId);
    if (!existing) return;

    // Price is never typed by hand here — it's either refreshed from the
    // coin's existing CoinGecko link, resolved from a newly-pasted link, or
    // (lacking either) rescaled at the same per-coin price it already had.
    withLoading(async () => {
      let coinId = existing.coinId || null;
      let value = existing.value;

      if (coinGeckoUrl) {
        try {
          const res = await fetch(`${API_BASE}/api/manual-price?url=${encodeURIComponent(coinGeckoUrl)}`);
          const data = await res.json();
          if (!res.ok) {
            alert(`Couldn't get a price from that CoinGecko link (${data.error}).`);
            return;
          }
          coinId = data.coinId;
          value = amount * data.price;
        } catch {
          alert("Couldn't reach the price lookup. Try again.");
          return;
        }
      } else if (coinId) {
        try {
          const priceRes = await fetch(`${API_BASE}/api/coin-price/${encodeURIComponent(coinId)}`);
          const priceData = await priceRes.json();
          if (priceRes.ok && Number.isFinite(priceData.price)) value = amount * priceData.price;
        } catch {
          // Keep the last known per-coin price if the live lookup fails.
        }
      } else {
        const perUnit = existing.amount > 0 ? existing.value / existing.amount : 0;
        value = amount * perUnit;
      }

      let priceAtFirstReceived = null;
      let historyLookupError = null;
      let needsManualPurchasePrice = false;
      if (firstReceivedDate) {
        if (isDateOlderThanOneYear(firstReceivedDate)) {
          // Too old for CoinGecko's free-tier history lookup, whether or not
          // this coin is even linked — the price per coin at purchase is
          // typed in by hand instead. Current price (when linked) still
          // comes from CoinGecko as normal, same as any other edit.
          if (Number.isFinite(manualPurchasePrice) && manualPurchasePrice > 0) {
            priceAtFirstReceived = manualPurchasePrice;
          } else {
            needsManualPurchasePrice = true;
          }
        } else if (coinId) {
          try {
            const histRes = await fetch(`${API_BASE}/api/coin-history/${encodeURIComponent(coinId)}?date=${firstReceivedDate}`);
            const histData = await histRes.json();
            if (histRes.ok && Number.isFinite(histData.price)) priceAtFirstReceived = histData.price;
            else historyLookupError = histData.error || 'Unknown error.';
          } catch (err) {
            historyLookupError = err.message || 'Could not reach the price lookup.';
          }
        }
      }

      manualCryptoPositions = manualCryptoPositions.map((m) =>
        m.id === manualId ? { ...m, symbol, name: name || symbol, amount, value, coinId, firstReceivedDate, priceAtFirstReceived } : m
      );
      saveManualCryptoPositions();
      syncProfileToServer();
      editingManualCryptoId = null;
      cryptoSnapshotUpdatedAt = new Date().toISOString();
      refreshCryptoPortfolioCard();

      // P&L silently staying "N/A" after setting a date is confusing — say
      // exactly why instead of leaving it to look like nothing happened. The
      // historical-lookup case shows CoinGecko's actual error rather than
      // guessing at a reason (e.g. it's not always "too old" — could be a
      // rate limit, an unlisted coin, or no data recorded for that date).
      if (firstReceivedDate && !coinId && !isDateOlderThanOneYear(firstReceivedDate)) {
        alert("Saved — but Unrealized P&L stays N/A for a recent purchase date without a linked asset (there's no automatic price to compare against). Paste a link in \"Link to Asset\", or use a purchase date over a year old to enter the price by hand instead.");
      } else if (needsManualPurchasePrice) {
        alert("Saved — but Unrealized P&L stays N/A until you enter a price per coin for that purchase date.");
      } else if (historyLookupError) {
        alert(`Saved, but couldn't get a historical price for that date: ${historyLookupError} P&L stays N/A until this is resolved.`);
      }
    });
    return;
  }

  // "Set date" save — for a wallet position the chain couldn't date at all.
  // Unlike the manual-position edit above, balance/symbol aren't editable
  // here (they come straight from the chain) — but the CoinGecko link is,
  // same as there, for a position that arrived with no coinId of its own.
  const saveDateEditBtn = event.target.closest('.save-date-edit-btn[data-position-id]');
  if (saveDateEditBtn) {
    const row = saveDateEditBtn.closest('.position-row-editing');
    const firstReceivedDate = row.querySelector('.edit-field-date-trigger').dataset.date || null;
    const coinGeckoUrl = row.querySelector('.edit-field-coingecko-url').value.trim();
    const manualPurchasePrice = Number(row.querySelector('.edit-field-purchase-price')?.value);
    const positionId = saveDateEditBtn.dataset.positionId;

    if (!firstReceivedDate) {
      alert('Pick a date.');
      return;
    }

    closeDatePicker();
    const pos = Object.values(cryptoSources)
      .flatMap((source) => source.positions || [])
      .find((p) => cryptoPositionId(p) === positionId);
    if (!pos) {
      editingDateOnlyId = null;
      refreshCryptoPortfolioCard();
      return;
    }

    withLoading(async () => {
      let coinId = pos.coinId || null;

      if (coinGeckoUrl) {
        try {
          const res = await fetch(`${API_BASE}/api/manual-price?url=${encodeURIComponent(coinGeckoUrl)}`);
          const data = await res.json();
          if (!res.ok) {
            alert(`Couldn't get a price from that CoinGecko link (${data.error}).`);
            return;
          }
          coinId = data.coinId;
        } catch {
          alert("Couldn't reach the price lookup. Try again.");
          return;
        }
      }

      let priceAtFirstReceived = null;
      let historyLookupError = null;
      let needsManualPurchasePrice = false;

      if (!isDateOlderThanOneYear(firstReceivedDate) && coinId) {
        try {
          const histRes = await fetch(`${API_BASE}/api/coin-history/${encodeURIComponent(coinId)}?date=${firstReceivedDate}`);
          const histData = await histRes.json();
          if (histRes.ok && Number.isFinite(histData.price)) priceAtFirstReceived = histData.price;
          else historyLookupError = histData.error || 'Unknown error.';
        } catch (err) {
          historyLookupError = err.message || 'Could not reach the price lookup.';
        }
      } else if (Number.isFinite(manualPurchasePrice) && manualPurchasePrice > 0) {
        priceAtFirstReceived = manualPurchasePrice;
      } else {
        needsManualPurchasePrice = true;
      }

      costBasisOverrides[positionId] = { firstReceivedDate, priceAtFirstReceived };
      saveCostBasisOverrides();

      editingDateOnlyId = null;
      cryptoSnapshotUpdatedAt = new Date().toISOString();
      refreshCryptoPortfolioCard();

      if (needsManualPurchasePrice) {
        alert("Saved — but Unrealized P&L stays N/A until you enter a price per coin for that purchase date.");
      } else if (historyLookupError) {
        alert(`Saved, but couldn't get a historical price for that date: ${historyLookupError} P&L stays N/A until this is resolved.`);
      }
    });
    return;
  }

  const deleteBtn = event.target.closest('.position-delete-btn[data-delete-manual-ids]');
  if (deleteBtn) {
    const ids = deleteBtn.dataset.deleteManualIds.split(',');
    const plural = ids.length > 1;
    const confirmed = confirm(
      `Permanently delete ${plural ? 'these manually-added assets' : 'this manually-added asset'}? ` +
      `This removes ${plural ? 'them' : 'it'} from your account for good — unlike hiding, you'd have to add ${plural ? 'them' : 'it'} again manually to get ${plural ? 'them' : 'it'} back.`
    );
    if (confirmed) {
      manualCryptoPositions = manualCryptoPositions.filter((m) => !ids.includes(m.id));
      saveManualCryptoPositions();
      syncProfileToServer();
      refreshCryptoPortfolioCard();
    }
    return;
  }

  const deleteSaleBtn = event.target.closest('.crypto-sale-delete-btn[data-sale-id]');
  if (deleteSaleBtn) {
    const id = deleteSaleBtn.dataset.saleId;
    if (confirm('Permanently delete this logged sale? This removes it from your Realized P&L for good.')) {
      manualCryptoSales = manualCryptoSales.filter((s) => s.id !== id);
      saveManualCryptoSales();
      syncProfileToServer();
      refreshCryptoPortfolioCard();
    }
    return;
  }

  // The "+ Log a sale" link inside the Crypto Portfolio card's Realized P&L
  // header jumps down to the actual form (it lives in the sidebar's Add
  // Account panel, id="crypto-sale-form") rather than duplicating it inline
  // — opens the form if it's collapsed, then scrolls it into view and
  // focuses the first field.
  const jumpToSaleBtn = event.target.closest('#crypto-jump-to-log-sale-btn');
  if (jumpToSaleBtn) {
    // The Add Account panel's type dropdown might be showing a different
    // account type (broker, bank, ...), which keeps crypto-subsection (and
    // this form inside it) hidden entirely — switch it back to crypto first.
    if (newAccountType.value !== 'crypto') {
      newAccountType.value = 'crypto';
      updateAccountTypeView();
    }
    if (cryptoSaleForm.style.display === 'none') cryptoSaleToggleBtn.click();
    cryptoSaleForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    cryptoSaleSymbolInput.focus();
    return;
  }

  const hideBtn = event.target.closest('.position-hide-btn[data-hide-id]');
  if (hideBtn) {
    // A merged row's data-hide-id is '|'-joined ids of every source position
    // it combines, so hiding it hides all of them, not just the merged row.
    hideBtn.dataset.hideId.split('|').forEach((id) => hiddenPositionIds.add(id));
    saveHiddenPositionIds();
    refreshCryptoPortfolioCard();
    return;
  }

  const unhideBtn = event.target.closest('[data-action="unhide-crypto"]');
  if (unhideBtn) {
    hiddenPositionIds.clear();
    saveHiddenPositionIds();
    refreshCryptoPortfolioCard();
    return;
  }

  const viewAccountExpensesBtn = event.target.closest('[data-action="view-account-expenses"]');
  if (viewAccountExpensesBtn) {
    goToPage('expenses');
    return;
  }

  const reconnectBtn = event.target.closest('.reconnect-btn[data-reconnect="avanza"]');
  if (reconnectBtn) {
    newAccountType.value = 'broker';
    refreshCustomSelect(newAccountType);
    updateAccountTypeView();
    stopBankidPolling();
    avanzaForm.reset();
    avanzaForm.style.display = 'none';
    avanzaBankidChooser.style.display = '';
    showAvanzaView('login');
    document.getElementById('avanza-login').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const paypalReconnectBtn = event.target.closest('.reconnect-btn[data-reconnect="paypal"]');
  if (paypalReconnectBtn) {
    newAccountType.value = 'paypal';
    refreshCustomSelect(newAccountType);
    updateAccountTypeView();
    paypalForm.reset();
    showPaypalView('login');
    document.getElementById('paypal-login').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const removeBtn = event.target.closest('.remove-btn[data-id]');
  if (removeBtn) {
    if (removeBtn.dataset.kind === 'live') {
      liveAccounts = liveAccounts.filter((a) => a.id !== removeBtn.dataset.id);
      if (removeBtn.dataset.id === 'crypto-portfolio') {
        Object.keys(cryptoSources).forEach((key) => delete cryptoSources[key]);
        savedWalletAddresses.clear();
        manualCryptoPositions = [];
        saveManualCryptoPositions();
        syncProfileToServer();
      } else if (removeBtn.dataset.id === 'avanza-group') {
        avanzaSummaries.clear();
        avanzaSnapshotPayload = null;
        syncProfileToServer();
      } else if (removeBtn.dataset.id === 'paypal-account') {
        paypalSnapshot = null;
        syncProfileToServer();
      }
    } else {
      accounts = accounts.filter((a) => a.id !== removeBtn.dataset.id);
      saveAccounts();
      syncProfileToServer();
    }
    render();
    return;
  }

  const header = event.target.closest('[data-toggle-id]');
  if (header && !event.target.closest('.drag-handle')) {
    const id = header.dataset.toggleId;
    const willExpand = !expandedIds.has(id);
    if (willExpand) expandedIds.add(id);
    else expandedIds.delete(id);

    // The detail pane is always in the DOM (see renderCard) — flip the
    // class on the existing element so the CSS transition actually has a
    // "before" state to animate from, instead of calling render(), which
    // would tear down and recreate every card's nodes with no transition.
    const wrap = header.closest('.account-card')?.querySelector('.account-detail-wrap');
    if (wrap) {
      header.querySelector('.chevron')?.classList.toggle('open', willExpand);
      wrap.classList.toggle('open', willExpand);
    } else {
      render();
    }
  }
});

// ── Drag-to-reorder account cards ───────────────────────────────────────────
// Only the small grip icon in each card's header is draggable (not the whole
// card), so dragging never fights with clicking buttons, expanding a card, or
// selecting text inside it. Reordering just edits cardOrder and re-renders —
// the actual card markup is unaffected.
//
// This uses pointer events rather than the native HTML5 DnD API. Native DnD
// leaves the dragged element in place (faded) and shows a browser-rendered
// "ghost" following the cursor, which feels laggy and disconnected. Instead
// the real card is lifted out of the list and moved with `transform` so it
// tracks the cursor 1:1, while a placeholder holds its spot in the grid and
// the other cards slide into place with a FLIP-animated transition.

let dragState = null;

function onDragPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  dragState.card.style.transform = `translate(${dx}px, ${dy}px)`;
  moveDragPlaceholder(event.clientY);
}

function onDragPointerEnd(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const { card, placeholder, handle, cardId } = dragState;

  handle.releasePointerCapture(event.pointerId);
  handle.removeEventListener('pointermove', onDragPointerMove);
  handle.removeEventListener('pointerup', onDragPointerEnd);
  handle.removeEventListener('pointercancel', onDragPointerEnd);
  document.body.classList.remove('dragging-active');

  if (placeholder.isConnected) {
    cardOrder = [...accountsList.children]
      .map((el) => (el === placeholder ? cardId : el.dataset.cardId))
      .filter(Boolean);
    saveCardOrder();
  }

  card.remove();
  placeholder.remove();
  dragState = null;
  render();
}

// Moves the placeholder to wherever the cursor currently is among the other
// cards, animating the displaced cards into their new slot (FLIP) instead of
// having them snap instantly — this is what makes the list feel like it's
// making room for the dragged card rather than just re-sorting underneath it.
function moveDragPlaceholder(clientY) {
  const { placeholder } = dragState;
  const siblings = [...accountsList.children].filter((el) => el !== placeholder);

  let target = null;
  for (const sib of siblings) {
    const rect = sib.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) { target = sib; break; }
  }
  if (target === placeholder.nextElementSibling) return;
  if (!target && !placeholder.nextElementSibling) return;

  const before = new Map(siblings.map((el) => [el, el.getBoundingClientRect()]));
  if (target) accountsList.insertBefore(placeholder, target);
  else accountsList.appendChild(placeholder);

  for (const el of siblings) {
    const dy = before.get(el).top - el.getBoundingClientRect().top;
    if (!dy) continue;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform 200ms ease';
      el.style.transform = '';
    });
  }
}

accountsList.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const handle = event.target.closest('.drag-handle');
  const card = handle?.closest('.account-card');
  if (!handle || !card) return;
  event.preventDefault();

  const rect = card.getBoundingClientRect();
  const placeholder = document.createElement('div');
  placeholder.className = 'account-card-placeholder';
  placeholder.style.height = `${rect.height}px`;
  card.after(placeholder);

  dragState = {
    pointerId: event.pointerId,
    card,
    placeholder,
    handle,
    cardId: card.dataset.cardId,
    startX: event.clientX,
    startY: event.clientY
  };

  card.classList.add('dragging');
  card.style.width = `${rect.width}px`;
  card.style.left = `${rect.left}px`;
  card.style.top = `${rect.top}px`;
  document.body.appendChild(card);
  document.body.classList.add('dragging-active');

  handle.setPointerCapture(event.pointerId);
  handle.addEventListener('pointermove', onDragPointerMove);
  handle.addEventListener('pointerup', onDragPointerEnd);
  handle.addEventListener('pointercancel', onDragPointerEnd);
});

// The inline account-edit form's type select shows/hides the account-ID
// field (only meaningful for a broker account) the same way the "Add
// account" form does, just scoped to whichever card is currently being
// edited.
accountsList.addEventListener('change', (event) => {
  const typeSelect = event.target.closest('.edit-field-type');
  if (!typeSelect) return;
  const card = typeSelect.closest('.account-card-edit');
  const isBroker = typeSelect.value === 'broker';
  card.querySelector('.edit-identifier-wrap').style.display = isBroker ? '' : 'none';
  card.querySelector('.edit-annual-return-wrap').style.display = ANNUAL_RETURN_TYPES.includes(typeSelect.value) ? '' : 'none';
});

function loadAccounts() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultAccounts;
  try {
    return JSON.parse(raw);
  } catch {
    return defaultAccounts;
  }
}

function saveAccounts() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
}

// Applies a signed USD delta (positive for an earning, negative for an
// expense) to one manually-added account's balance — used when a daily
// expense/earning entry is linked to an account instead of just being logged
// on its own. Scales positions with it (see scalePositionsToBalance) and
// bumps updatedAt so the account's daily-return estimate and growth accrual
// are computed from the new balance going forward, not the pre-adjustment one.
function applyAccountBalanceDelta(accountId, deltaUSD) {
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return;
  const newBalance = account.balance + deltaUSD;
  accounts = accounts.map((a) =>
    a.id === accountId
      ? { ...a, balance: newBalance, positions: scalePositionsToBalance(a.positions, a.balance, newBalance), updatedAt: new Date().toISOString() }
      : a
  );
  saveAccounts();
}

// Manually-added coins (see the "Coin symbol"/"Amount of coins" fields in
// the manual-entry form) — stored separately from `accounts` because they
// don't render as their own card; they're merged straight into the Crypto
// Portfolio card's position list, same as on-chain coins.
function loadManualCryptoPositions() {
  try {
    return JSON.parse(localStorage.getItem(MANUAL_CRYPTO_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveManualCryptoPositions() {
  localStorage.setItem(MANUAL_CRYPTO_KEY, JSON.stringify(manualCryptoPositions));
}

// Manually-logged crypto sales (see the "Log a crypto sale" form) — closed
// trades, kept separate from manualCryptoPositions since they represent an
// exit rather than a current holding.
function loadManualCryptoSales() {
  try {
    return JSON.parse(localStorage.getItem(MANUAL_CRYPTO_SALES_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveManualCryptoSales() {
  localStorage.setItem(MANUAL_CRYPTO_SALES_KEY, JSON.stringify(manualCryptoSales));
}

// Every currency amount in the app funnels through this, so the decimals/
// separator settings apply everywhere uniformly instead of each formatter
// hardcoding its own fraction-digit count.
function formatMoney(value, currencyCode) {
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: numberDecimals,
    maximumFractionDigits: numberDecimals
  }).format(value);
  return maskIfPrivate(applyDecimalSeparator(formatted));
}

// Formats a value that's already in the current display currency (e.g. a
// sum of several already-converted amounts) — no further conversion.
function formatConvertedCurrency(value) {
  return formatMoney(value, displayCurrency);
}

// ── Coin / asset icons ──────────────────────────────────────────────────────
// A small circular badge shown next to every coin symbol and stock ticker.
// Real logos come from CoinCap's public icon CDN (keyed by lowercase symbol,
// no API key required) since it covers essentially every crypto asset this
// app can load; anything it doesn't have — every stock ticker, plus any coin
// outside CoinCap's set — falls back to a colored initial badge instead of a
// broken image. The fallback letter sits underneath the <img> in the DOM the
// whole time, so a failed image load just reveals it (no flash of a missing
// image icon).
const ASSET_ICON_PALETTE = ['#be123c', '#d97706', '#34d399', '#60a5fa', '#a78bfa', '#fb7185', '#22d3ee', '#fbbf24'];

function colorForSymbol(symbol) {
  const s = (symbol || '?').toUpperCase();
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return ASSET_ICON_PALETTE[hash % ASSET_ICON_PALETTE.length];
}

function assetIconHtml(symbol) {
  const sym = (symbol || '?').trim();
  const initial = sym.slice(0, 1).toUpperCase() || '?';
  const color = colorForSymbol(sym);
  const src = `https://assets.coincap.io/assets/icons/${encodeURIComponent(sym.toLowerCase())}@2x.png`;
  return `
    <span class="asset-icon" style="--asset-icon-color:${color}">
      <span class="asset-icon-fallback">${initial}</span>
      <img src="${src}" alt="" loading="lazy" onerror="this.remove()" />
    </span>
  `;
}

// Account-card-level icon (crypto wallet, broker, PayPal, bank, …) — a fixed
// glyph per account type rather than a fetched logo, since these represent a
// category of account rather than a single tradeable asset.
const ACCOUNT_TYPE_ICONS = {
  wallet: '<path d="M4 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v2h-4a3 3 0 0 0 0 6h4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /><circle cx="15" cy="12" r="1.2" fill="currentColor" />',
  broker: '<path d="M4 19V10M10 19V5M16 19v-7M20 19H4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />',
  paypal: '<path d="M8 6h5.5a3.2 3.2 0 0 1 3.1 4A4.6 4.6 0 0 1 12 13.5H9.7L9 18H6.2L8 6Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />',
  bank: '<path d="M4 10h16M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18M12 3 3 8h18L12 3Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />',
  savings: '<path d="M5 12a5 5 0 0 1 9-3l2-1 1 2-1.3 1.3A5 5 0 0 1 16 12v3a1 1 0 0 1-1 1h-1v2H9v-2H8a5 5 0 0 1-3-4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /><circle cx="12" cy="11" r=".8" fill="currentColor" />',
  investment: '<path d="M4 17l5-5 4 3 7-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /><path d="M15 6h5v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />',
  retirement: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />',
  other: '<circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.6" />'
};

const ACCOUNT_TYPE_COLORS = {
  wallet: '#34d399',
  broker: '#60a5fa',
  paypal: '#60a5fa',
  bank: '#fbbf24',
  savings: '#a78bfa',
  investment: '#34d399',
  retirement: '#fb7185',
  other: '#a8888d'
};

function accountTypeIconHtml(type) {
  const key = ACCOUNT_TYPE_ICONS[type] ? type : 'other';
  return `
    <span class="account-type-icon" style="--asset-icon-color:${ACCOUNT_TYPE_COLORS[key]}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${ACCOUNT_TYPE_ICONS[key]}</svg>
    </span>
  `;
}

function formatCurrency(value) {
  return formatConvertedCurrency(convertToDisplayCurrency(value, 'USD'));
}

// ── Unified card rendering ──────────────────────────────────────────────────
// Manual accounts and live wallet/Avanza results all render through the same
// card shell: a brief always-visible header + balance, and an expandable
// detail section that's collapsed by default.

function renderCard(spec) {
  const expanded = expandedIds.has(spec.id);
  return `
    <article class="account-card" data-card-id="${spec.id}">
      <div class="account-card-header" data-toggle-id="${spec.id}">
        <span class="drag-handle" title="Drag to reorder">&#8942;&#8942;</span>
        <div class="account-card-title">
          <div class="account-card-title-main">
            ${spec.icon || ''}
            <h3>${spec.title}</h3>
          </div>
          <div class="meta">${spec.meta}</div>
        </div>
        <div class="account-card-header-right">
          <span class="account-card-value">
            ${spec.headlineValue}
            ${spec.headlineSub ? `<span class="headline-sub ${spec.headlineSubClass || ''}">${spec.headlineSub}</span>` : ''}
          </span>
          <span class="chevron ${expanded ? 'open' : ''}">&#9662;</span>
        </div>
      </div>
      <div class="account-detail-wrap${expanded ? ' open' : ''}"><div class="account-detail">${spec.detailHtml}</div></div>
      <div class="account-card-footer">
        <span class="meta">${spec.footerNote || ''}</span>
        <span class="account-card-footer-actions">
          ${spec.reconnectAction ? `<button class="link-btn reconnect-btn" data-reconnect="${spec.reconnectAction}" type="button" title="Refreshing Avanza data requires logging in again">${t('common.refresh')}</button>` : ''}
          ${spec.editId ? `
            <button class="edit-btn" data-edit-id="${spec.editId}" title="Edit this account">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M4 20h4l10.5-10.5a2.83 2.83 0 0 0-4-4L4 16v4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          ` : ''}
          ${spec.removeId ? `
            <button class="remove-btn" data-id="${spec.removeId}" data-kind="${spec.removeKind}" title="${t('common.remove')}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
              </svg>
            </button>
          ` : ''}
        </span>
      </div>
    </article>
  `;
}

// Keeps an account's position breakdown proportional to its balance whenever
// the balance changes out from under it (manual edit, an expense/earning
// applied to the account, or accrued growth) — without this, a legacy
// account's positions (or a wallet/broker account's real multi-position
// list) stay frozen at whatever value they had when the balance last
// matched them, so the expanded card detail silently drifts away from the
// headline balance on every subsequent change.
function scalePositionsToBalance(positions, oldBalance, newBalance) {
  if (!Array.isArray(positions) || !positions.length) return positions;
  if (!Number.isFinite(oldBalance) || oldBalance === 0) return positions;
  const ratio = newBalance / oldBalance;
  return positions.map((p) => ({ ...p, value: p.value * ratio }));
}

// Turns a nominal annual return (e.g. 7 for 7%) into the compounded daily
// rate that grows a balance to that same annual figure over 365 days.
function dailyReturnRate(annualReturnPercent) {
  return Math.pow(1 + Number(annualReturnPercent) / 100, 1 / 365) - 1;
}

// Today's estimated gain/loss in USD for an account carrying an annual
// return assumption — null for account types that don't track one.
function estimateDailyReturn(account) {
  // account.annualReturn is null for bank/broker accounts (and any
  // investment/savings/retirement account that just never got one set) —
  // Number(null) coerces to 0, which Number.isFinite would accept, so the
  // null check has to come first or a "no annual return" account renders a
  // bogus "+$0.00/day" instead of no daily-return line at all.
  if (account.annualReturn == null || !Number.isFinite(Number(account.annualReturn))) return null;
  return account.balance * dailyReturnRate(account.annualReturn);
}

// Compounds an annual-return-bearing account's actual stored balance for
// every whole day elapsed since it was last touched — estimateDailyReturn
// above only ever painted a "+9c/day" estimate next to a balance that stayed
// static forever, it never grew the balance itself. Advances updatedAt by
// exactly the whole days applied (not to "now") so a leftover partial day
// still counts on the next call instead of being discarded.
function accrueAccountGrowth(accountsList) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const now = Date.now();
  let changed = false;

  const next = accountsList.map((account) => {
    if (!ANNUAL_RETURN_TYPES.includes(account.type)) return account;
    if (account.annualReturn == null || !Number.isFinite(Number(account.annualReturn)) || !account.updatedAt) return account;

    const wholeDays = Math.floor((now - new Date(account.updatedAt).getTime()) / msPerDay);
    if (wholeDays < 1) return account;

    changed = true;
    const newBalance = account.balance * Math.pow(1 + dailyReturnRate(account.annualReturn), wholeDays);
    return {
      ...account,
      balance: newBalance,
      positions: scalePositionsToBalance(account.positions, account.balance, newBalance),
      updatedAt: new Date(new Date(account.updatedAt).getTime() + wholeDays * msPerDay).toISOString()
    };
  });

  return { accounts: next, changed };
}

// A brief, most-recent-first look at the expenses/earnings linked to this
// account (see the "Account (optional)" field on the Expenses page's add
// form) — same idea as expanding the crypto card to see its positions,
// except this works for any account type an expense happens to be linked
// to, not just whichever one someone's daily spending is tracked against.
// Scoped to a rolling 7-day window rather than a flat count so the card
// stays a quick "what happened recently" glance — anything older is still
// just a click away via the link into the full Expenses page.
const LINKED_EXPENSES_WINDOW_DAYS = 7;
function linkedExpensesHtml(accountId) {
  const allLinked = expenses
    .filter((e) => e.accountId === accountId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  if (!allLinked.length) {
    return `
      <div class="linked-expenses">
        <h4 class="linked-expenses-heading">${t('card.linkedExpenses')}</h4>
        <p class="avanza-note">${t('card.noLinkedExpenses')}</p>
      </div>
    `;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LINKED_EXPENSES_WINDOW_DAYS);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  const recent = allLinked.filter((e) => e.date >= cutoffISO);

  const rowsHtml = recent
    .map((e) => {
      const type = e.type === 'earning' ? 'earning' : 'expense';
      const catMap = categoryMapForType(type);
      const cat = catMap.get(e.category) || catMap.get('other');
      const label = categoryLabel(cat, type);
      const dateLabel = parseISODateLocal(e.date).toLocaleDateString('en-US', { dateStyle: 'medium' });
      const amountLabel = `${type === 'earning' ? '+' : '-'}${formatCurrency(e.amount)}`;
      return `
        <li class="linked-expense-row">
          ${categorySwatchHtml(cat)}
          <span class="linked-expense-desc">${e.description || label}</span>
          <span class="meta">${dateLabel}</span>
          <span class="linked-expense-amount ${type === 'earning' ? 'gain' : 'loss'}">${amountLabel}</span>
        </li>
      `;
    })
    .join('');

  const olderCount = allLinked.length - recent.length;

  return `
    <div class="linked-expenses">
      <div class="linked-expenses-heading">
        <h4>${t('card.linkedExpenses')}</h4>
        <button class="link-btn" type="button" data-action="view-account-expenses" data-account-id="${accountId}">${t('card.viewAllExpenses')}</button>
      </div>
      ${recent.length
        ? `<ul class="linked-expenses-list">${rowsHtml}</ul>`
        : `<p class="avanza-note">${t('card.noRecentLinkedExpenses')}</p>`}
      ${olderCount > 0 ? `<p class="avanza-note">${tMoreLinkedExpenses(olderCount)}</p>` : ''}
    </div>
  `;
}

function manualAccountCardSpec(account) {
  // Newly-created accounts start with no positions at all — a flat account
  // (bank/savings/investment/etc.) is just a balance, it never had a real
  // breakdown to show here (only a legacy/wallet-seeded account does).
  const positionsHtml = account.positions.length
    ? `
      <ul class="positions-list">
        ${account.positions
          .map(
            (position) => `
              <li>
                <span class="asset-name">${assetIconHtml(position.symbol)}${position.symbol}</span>
                <span>${maskIfPrivate(position.amount)} &middot; ${formatCurrency(position.value)}</span>
              </li>
            `
          )
          .join('')}
      </ul>
    `
    : '';

  const dailyReturn = estimateDailyReturn(account);

  return {
    id: account.id,
    title: account.name,
    icon: accountTypeIconHtml(account.type),
    meta: account.identifier,
    badgeLabel: account.type,
    headlineValue: formatCurrency(account.balance),
    headlineSub: dailyReturn != null ? `${dailyReturn >= 0 ? '+' : ''}${fmtCurrency(dailyReturn, 'USD')}/day` : null,
    headlineSubClass: gainClass(dailyReturn),
    detailHtml: positionsHtml + linkedExpensesHtml(account.id),
    // Legacy accounts saved before this field existed have no updatedAt —
    // falls back to the old static label rather than showing a bogus date.
    footerNote: account.updatedAt ? `${t('common.lastUpdated')} ${formatLastUpdated(account.updatedAt)}` : t('card.trackedPosition'),
    // The manual form only knows how to represent broker/bank/savings/
    // investment accounts (name + balance + optional ID) — a legacy 'wallet'
    // seed account has a different shape (a positions list) the form can't
    // edit, so it only gets the Remove button.
    editId: account.type === 'wallet' ? null : account.id,
    removeId: account.id,
    removeKind: 'manual'
  };
}

// Renders a flat account (broker/bank/savings/investment) as an inline edit
// form, right in its own spot in the list, instead of the usual card — so
// editing happens where the account already is rather than in a separate
// panel. Only reachable for types the form can represent (see editId above).
function renderAccountEditCard(account) {
  const isBroker = account.type === 'broker';
  return `
    <article class="account-card account-card-edit" data-card-id="${account.id}">
      <div class="account-edit-fields account-form">
        <label>
          ${t('common.displayName')}
          <input type="text" class="edit-field-name" value="${account.name || ''}" />
        </label>
        <label>
          ${t('edit.accountType')}
          <select class="edit-field-type">
            <option value="broker" ${account.type === 'broker' ? 'selected' : ''}>${t('accountType.broker')}</option>
            <option value="bank" ${account.type === 'bank' ? 'selected' : ''}>${t('accountType.bank')}</option>
            <option value="savings" ${account.type === 'savings' ? 'selected' : ''}>${t('accountType.savings')}</option>
            <option value="investment" ${account.type === 'investment' ? 'selected' : ''}>${t('accountType.investment')}</option>
            <option value="retirement" ${account.type === 'retirement' ? 'selected' : ''}>${t('accountType.retirement')}</option>
            <option value="other" ${account.type === 'other' ? 'selected' : ''}>${t('accountType.other')}</option>
          </select>
        </label>
        <label class="edit-identifier-wrap" style="display:${isBroker ? '' : 'none'}">
          ${t('edit.walletId')}
          <input type="text" class="edit-field-identifier" value="${account.identifier || ''}" />
        </label>
        <label>
          ${t('common.balance')} (${displayCurrency})
          <input type="number" step="any" class="edit-field-balance" value="${convertToDisplayCurrency(account.balance, 'USD').toFixed(2)}" />
        </label>
        <label class="edit-annual-return-wrap" style="display:${ANNUAL_RETURN_TYPES.includes(account.type) ? '' : 'none'}">
          ${t('edit.annualReturn')}
          <input type="number" step="any" class="edit-field-annual-return" value="${account.annualReturn ?? ''}" />
        </label>
        <div class="account-edit-actions">
          <button type="button" class="save-account-edit-btn" data-account-id="${account.id}">${t('edit.saveChanges')}</button>
          <button type="button" class="cancel-account-edit-btn">${t('edit.cancel')}</button>
        </div>
      </div>
    </article>
  `;
}

// An account/position whose balance is this close to zero adds clutter
// without adding information (e.g. a stray 0.78 SEK savings account still
// rounds to "$0" once converted/displayed) — hide it instead of showing a
// card that just says $0, same idea as the crypto dust-position filter.
function isMeaningfulValue(value, threshold = 1) {
  return Math.abs(Number(value) || 0) >= threshold;
}

function render() {
  const visibleAccounts = accounts.filter((a) => isMeaningfulValue(a.balance));
  // Each liveAccounts entry carries its own native currency (crypto: USD,
  // Avanza: SEK) — convert every value to the current display currency
  // individually before summing, instead of summing raw numbers and
  // formatting the sum as if it were all one currency.
  const manualTotal = visibleAccounts.reduce((sum, account) => sum + convertToDisplayCurrency(Number(account.balance || 0), 'USD'), 0);
  const liveTotal = liveAccounts.reduce((sum, item) => sum + convertToDisplayCurrency(Number(item.currentValue || 0), item.currency || 'USD'), 0);
  const totalCount = visibleAccounts.length + liveAccounts.length;

  totalPortfolio.textContent = formatConvertedCurrency(manualTotal + liveTotal);
  accountCount.textContent = tAccountsConnected(totalCount);

  if (!totalCount) {
    accountsList.innerHTML = `<p class="empty-state">${t('emptyState.noAccounts')}</p>`;
    return;
  }

  const cardEntries = [
    ...liveAccounts.map((spec) => ({ id: spec.id, html: renderCard(spec) })),
    ...visibleAccounts.map((a) => ({
      id: a.id,
      html: a.id === editingAccountId ? renderAccountEditCard(a) : renderCard(manualAccountCardSpec(a))
    }))
  ];

  reconcileCardOrder(cardEntries.map((c) => c.id));
  accountsList.innerHTML = sortByCardOrder(cardEntries, (c) => c.id).map((c) => c.html).join('');
  // The inline edit form's type select (if any account is currently being
  // edited) is fresh markup every render — enhance it same as the static
  // selects elsewhere.
  accountsList.querySelectorAll('select').forEach(enhanceSelect);

  renderExpenseAccountOptions();
}

// Catches up any accounts that accrued whole days of growth while the app
// was closed, before the very first paint.
{
  const accrued = accrueAccountGrowth(accounts);
  if (accrued.changed) {
    accounts = accrued.accounts;
    saveAccounts();
    syncProfileToServer();
  }
}

render();

// Keeps "Add account" and "Portfolio news" matched to "Your accounts"'
// height, in the desktop 3-column layout — the accounts panel is the fixed
// reference (its own height is never touched), the other two get resized to
// meet it: the form just gets extra blank space below it, and the news
// list's own internal scroll area (normally capped at a flat 700px, see
// .news-list) gets that cap replaced with whatever height actually closes
// the gap. A ResizeObserver on the accounts panel means this stays correct
// through anything that changes its height — adding/removing accounts,
// expanding/collapsing a card (including mid-animation), or the window
// itself resizing — without having to hook every one of those individually.
{
  const portfolioGrid = document.querySelector('#page-portfolio .content-grid');
  const formPanelEl = portfolioGrid?.querySelector('.form-panel');
  const accountsPanelEl = document.getElementById('accounts-panel');
  const newsPanelEl = portfolioGrid?.querySelector('.news-panel');

  function syncPortfolioPanelHeights() {
    if (!formPanelEl || !accountsPanelEl || !newsPanelEl) return;

    // Below the 900px breakpoint the grid collapses to one column per row
    // (see the responsive rules at the bottom of styles.css) — matching
    // heights there would just force pointless scrollbars on stacked panels.
    if (window.innerWidth <= 900) {
      formPanelEl.style.height = '';
      newsPanelEl.style.height = '';
      newsListEl.style.maxHeight = '';
      return;
    }

    // Clear any previously-applied sizing first so the measurements below
    // reflect natural content, not a stale constraint from the last sync.
    formPanelEl.style.height = '';
    newsPanelEl.style.height = '';
    newsListEl.style.maxHeight = '';

    const target = accountsPanelEl.offsetHeight;
    // Whatever in the news panel isn't the scrollable list itself (heading,
    // sort controls, padding) — subtracted out so only the list's own
    // allowance gets capped, keeping the heading always visible.
    const newsChrome = newsPanelEl.offsetHeight - newsListEl.offsetHeight;

    formPanelEl.style.height = `${target}px`;
    newsPanelEl.style.height = `${target}px`;
    newsListEl.style.maxHeight = `${Math.max(target - newsChrome, 80)}px`;
  }

  if (accountsPanelEl) {
    new ResizeObserver(syncPortfolioPanelHeights).observe(accountsPanelEl);
  }
  window.addEventListener('resize', syncPortfolioPanelHeights);
}

// ── Form/accounts/news panel-width resize ────────────────────────────────
// Two drag handles (see .panel-resize-handle in styles.css) straddle the
// gaps on either side of the accounts panel: one against the "Add
// account" form, one against the news panel. Each sets a CSS var
// (--form-panel-width / --news-panel-width) that .content-grid's outer
// columns read; the accounts panel between them is always the grid's 1fr
// column, so it absorbs whichever side gets dragged automatically — this
// is what actually makes the accounts panel itself resizable, rather than
// just the panel on the far side of whichever handle moved. Each handle's
// max is derived live from the *other* side panel's current width and the
// accounts panel's own minimum (not a fixed cap), so neither drag can
// squeeze the accounts panel unreadably small regardless of where the
// other handle currently sits.
{
  const grid = document.querySelector('#page-portfolio .content-grid');
  const formPanelEl = grid?.querySelector('.form-panel');
  const newsPanelEl = grid?.querySelector('.news-panel');
  const formHandle = document.getElementById('form-panel-resize-handle');
  const newsHandle = document.getElementById('news-panel-resize-handle');

  if (grid && formPanelEl && newsPanelEl && formHandle && newsHandle) {
    const MIN_FORM_WIDTH = 260;
    const MIN_NEWS_WIDTH = 260;
    // The accounts panel's default width already sits fairly close to a
    // 420px floor on common laptop widths, leaving only a few dozen
    // draggable pixels before either handle hit the clamp and stopped
    // responding — 320px still comfortably fits the stat-cards row (which
    // shrinks to fit rather than overflowing, see .stats-cards) and gives
    // both handles real range to be dragged.
    const MIN_ACCOUNTS_WIDTH = 320;
    const COLUMN_GAP = 24; // matches .content-grid's `gap`; two gaps span the three columns
    const ARROW_KEY_STEP = 24;

    // sign says which way a rightward pointer/arrow move affects this
    // handle's own panel: -1 for the news handle (its panel is to the
    // handle's right, so moving right shrinks it), +1 for the form handle
    // (its panel is on the far side of the accounts column, so moving
    // right — toward the accounts panel — grows it).
    function setupPanelResize({ handle, panelEl, otherPanelEl, cssVar, storageKey, min, sign }) {
      function clampWidth(desired) {
        const available = grid.clientWidth - COLUMN_GAP * 2 - otherPanelEl.getBoundingClientRect().width;
        const maxWidth = Math.max(min, available - MIN_ACCOUNTS_WIDTH);
        return Math.round(Math.min(Math.max(desired, min), maxWidth));
      }

      function applyWidth(width) {
        grid.style.setProperty(cssVar, `${width}px`);
      }

      const storedWidth = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(storedWidth) && storedWidth > 0) applyWidth(clampWidth(storedWidth));

      let dragStartX = 0;
      let dragStartWidth = 0;

      function onPointerMove(event) {
        const dx = event.clientX - dragStartX;
        applyWidth(clampWidth(dragStartWidth + sign * dx));
      }

      function onPointerUp(event) {
        handle.classList.remove('panel-resize-handle-active');
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerUp);
        handle.removeEventListener('pointercancel', onPointerUp);
        localStorage.setItem(storageKey, String(Math.round(panelEl.getBoundingClientRect().width)));
      }

      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        dragStartX = event.clientX;
        dragStartWidth = panelEl.getBoundingClientRect().width;
        handle.classList.add('panel-resize-handle-active');
        handle.setPointerCapture(event.pointerId);
        handle.addEventListener('pointermove', onPointerMove);
        handle.addEventListener('pointerup', onPointerUp);
        handle.addEventListener('pointercancel', onPointerUp);
        event.preventDefault();
      });

      // Keyboard equivalent for the role="separator" handle — arrow keys
      // move the boundary itself, same as dragging left/right with a mouse.
      handle.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const current = panelEl.getBoundingClientRect().width;
        const dx = event.key === 'ArrowLeft' ? -ARROW_KEY_STEP : ARROW_KEY_STEP;
        const next = clampWidth(current + sign * dx);
        applyWidth(next);
        localStorage.setItem(storageKey, String(next));
      });

      // Re-clamp on viewport changes so a width that was valid at one
      // window size can't leave the accounts panel squeezed below its
      // minimum at a narrower one.
      window.addEventListener('resize', () => {
        applyWidth(clampWidth(panelEl.getBoundingClientRect().width));
      });
    }

    setupPanelResize({
      handle: formHandle,
      panelEl: formPanelEl,
      otherPanelEl: newsPanelEl,
      cssVar: '--form-panel-width',
      storageKey: FORM_PANEL_WIDTH_KEY,
      min: MIN_FORM_WIDTH,
      sign: 1
    });

    setupPanelResize({
      handle: newsHandle,
      panelEl: newsPanelEl,
      otherPanelEl: formPanelEl,
      cssVar: '--news-panel-width',
      storageKey: NEWS_PANEL_WIDTH_KEY,
      min: MIN_NEWS_WIDTH,
      sign: -1
    });
  }
}

function upsertLiveAccount(spec, { autoExpand = true, scrollTo = true } = {}) {
  const existing = liveAccounts.findIndex((a) => a.id === spec.id);
  if (existing >= 0) liveAccounts[existing] = spec;
  else liveAccounts = [spec, ...liveAccounts];

  if (autoExpand) expandedIds.add(spec.id);
  render();

  if (scrollTo) {
    document.querySelector(`[data-toggle-id="${spec.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// Rebuilds the crypto portfolio card in place (e.g. after hiding a position)
// without forcing it open or scrolling to it, unlike upsertLiveAccount.
function refreshCryptoPortfolioCard() {
  if (!Object.keys(cryptoSources).length && !manualCryptoPositions.length && !manualCryptoSales.length) return;
  const spec = buildCryptoPortfolioCardSpec();
  const idx = liveAccounts.findIndex((a) => a.id === spec.id);
  if (idx >= 0) liveAccounts[idx] = spec;
  else liveAccounts = [spec, ...liveAccounts];
  render();
  scheduleNewsRefresh();
}

// ── Crypto wallet + staking ──────────────────────────────────────────────────
// Wallet holdings and staked positions (from different chains/addresses) are
// merged into one "Crypto Portfolio" card rather than a card per source.

const walletForm         = document.getElementById('wallet-form');
const walletAddressInput = document.getElementById('wallet-address');
const walletLoadBtn      = document.getElementById('wallet-load-btn');

const cryptoSources = {};

// When the Crypto Portfolio card's data was last actually fetched/refreshed
// (a chain reload or a manual-position price refresh) — shown as a "last
// updated" disclaimer on the card, same idea as the Avanza snapshot above.
let cryptoSnapshotUpdatedAt = null;

// Guesses which chain(s) an address belongs to from its format alone.
// Ethereum, BNB Smart Chain, and Optimism all share the same 0x... address
// space (same key, same bytes) — there's no way to tell them apart from the
// string, so a 0x address is checked against all three instead of picking
// one. Everything else has a distinguishing prefix/length, except Solana,
// which is a raw base58 pubkey with no marker — so it's the last-resort
// fallback, tried only once nothing more specific has matched.
function detectChains(address) {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return ['ethereum', 'bsc', 'optimism'];
  if (/^r[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)) return ['xrp'];
  if (/^G[A-Z2-7]{55}$/.test(address)) return ['stellar'];
  if (/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(address)) return ['ton'];
  if (/^(L|M)[1-9A-HJ-NP-Za-km-z]{25,33}$/.test(address) || /^ltc1[0-9a-z]{20,60}$/.test(address)) return ['litecoin'];
  if (/^[a-f0-9]{64}$/.test(address) || /\.(near|testnet)$/i.test(address)) return ['near'];
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return ['solana'];
  return [];
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

// Loads one chain's positions into cryptoSources under a stable key, reusing
// the dedicated Ethereum/Solana endpoints (richer scans with cost-basis and
// staking data) and falling back to the generic /api/chain route otherwise.
async function loadChainPositions(chain, address) {
  if (chain === 'ethereum') {
    const data = await fetchJson(`${API_BASE}/api/wallet/${address}`, 60_000);
    cryptoSources.wallet = { address, positions: data.positions.map((p) => ({ ...p, kind: 'wallet' })) };
    return;
  }
  if (chain === 'solana') {
    const data = await fetchJson(`${API_BASE}/api/solana/${address}`, 30_000);
    cryptoSources.solana = {
      address,
      positions: data.positions.map((p) => ({ ...p, kind: p.type === 'staked' ? 'staked-sol' : 'sol-liquid' }))
    };
    return;
  }
  const data = await fetchJson(`${API_BASE}/api/chain/${chain}/${address}`, 30_000);
  cryptoSources[chain] = {
    address,
    positions: data.positions.map((p) => ({ ...p, kind: 'simple-chain', chainId: chain }))
  };
}

// Addresses the user has loaded, kept in sync with the server-side profile
// so they can be reloaded automatically after a future login.
const savedWalletAddresses = new Set();

// Shared by the wallet form and by profile restore-on-login — detects chains,
// loads positions from every matching chain, and merges them into the card.
async function loadWalletAddress(address, upsertOptions) {
  const chains = detectChains(address);
  if (!chains.length) {
    throw new Error(`Couldn't tell which chain "${address}" belongs to. Double-check the address.`);
  }

  const results = await Promise.allSettled(chains.map((chain) => loadChainPositions(chain, address)));
  const failures = results.filter((r) => r.status === 'rejected');

  if (failures.length === results.length) {
    throw new Error(failures[0].reason?.message || 'Failed to load wallet.');
  }

  cryptoSnapshotUpdatedAt = new Date().toISOString();
  upsertLiveAccount(buildCryptoPortfolioCardSpec(), upsertOptions);
  return { total: results.length, failures };
}

walletForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const address = walletAddressInput.value.trim();

  walletLoadBtn.disabled = true;
  walletLoadBtn.textContent = 'Loading… (may take 10–20 s)';

  withLoading(async () => {
    try {
      const { total, failures } = await loadWalletAddress(address);
      walletForm.reset();

      savedWalletAddresses.add(address);
      syncProfileToServer();

      if (failures.length) {
        alert(`Loaded ${total - failures.length}/${total} chain(s). Failed: ${failures.map((f) => f.reason.message).join('; ')}`);
      }
    } catch (err) {
      alert(`Failed to load wallet: ${err.message}`);
    } finally {
      walletLoadBtn.disabled = false;
      walletLoadBtn.textContent = 'Load wallet';
    }
  });
});

function fmtUSD(value) {
  if (value == null) return 'N/A';
  return formatMoney(convertToDisplayCurrency(value, 'USD'), displayCurrency);
}

function fmtBalance(value) {
  if (value == null) return 'N/A';
  return maskIfPrivate(
    value < 0.0001
      ? value.toExponential(3)
      : value.toLocaleString('en-US', { maximumSignificantDigits: 6 })
  );
}

// ── Custom date picker ──────────────────────────────────────────────────────
// The native <input type="date"> calendar popup is drawn by the browser in
// the OS/browser's own language, which can end up mismatched with the app
// (English throughout) regardless of what the page itself says — there's no
// reliable way to force its language from CSS or JS. This is a small
// self-contained calendar instead, with month/weekday names hardcoded in
// English so it always matches the rest of the UI.

const DATE_PICKER_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DATE_PICKER_WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function formatDatePickerDisplay(iso) {
  if (!iso) return 'Select date';
  const [y, m, d] = iso.split('-').map(Number);
  return `${DATE_PICKER_MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
}

// Deferred from the Expenses section further up the file — see the comment
// there. Safe here: DATE_PICKER_MONTHS above has now actually been declared.
setDateTriggerValue(expenseDateTrigger, todayLocalISODate());

// CoinGecko's free/demo tier only serves historical prices for roughly the
// last 365 days — past that, a purchase price has to be typed in by hand
// instead of looked up automatically.
function isDateOlderThanOneYear(iso) {
  if (!iso) return false;
  return new Date(iso).getTime() < Date.now() - 365 * 24 * 60 * 60 * 1000;
}

let datePickerState = null;

function closeDatePicker() {
  if (!datePickerState) return;
  datePickerState.popup.remove();
  document.removeEventListener('pointerdown', onDatePickerOutsideClick, true);
  datePickerState = null;
}

function onDatePickerOutsideClick(event) {
  if (!datePickerState) return;
  if (datePickerState.popup.contains(event.target) || event.target === datePickerState.trigger) return;
  closeDatePicker();
}

function selectDatePickerDate(iso) {
  const { trigger } = datePickerState;
  trigger.dataset.date = iso;
  // Only the label span's text changes — the trigger button also holds a
  // calendar icon, so overwriting the whole button's content (as plain
  // textContent) would silently delete that icon on the first pick.
  const label = trigger.querySelector('.edit-field-date-trigger-label');
  if (label) label.textContent = formatDatePickerDisplay(iso);
  else trigger.textContent = formatDatePickerDisplay(iso);
  updatePurchasePriceFieldVisibility(trigger);
  // The custom-range expense filters used to be native <input type="date">
  // elements with a 'change' listener driving renderExpenses() — picking a
  // day here is this picker's equivalent of that change, for those two.
  if (trigger === expenseRangeFromTrigger || trigger === expenseRangeToTrigger) renderExpenses();
  closeDatePicker();
}

// Shows/hides the "Price per Coin at Purchase" fallback field purely based
// on how old the picked date is (vs. today, on the calendar) — CoinGecko's
// free tier can't look up a historical price past ~365 days regardless of
// whether the coin is linked, so past that point a purchase price is always
// typed in by hand instead.
function updatePurchasePriceFieldVisibility(trigger) {
  const wrap = trigger.closest('.position-row-editing')?.querySelector('.edit-field-purchase-price-wrap');
  if (!wrap) return;
  wrap.style.display = isDateOlderThanOneYear(trigger.dataset.date) ? '' : 'none';
}

// Three views share one popup: the day grid (default), a month grid, and a
// year grid — clicking the month or year label in the day grid's header
// jumps straight to the matching picker instead of paging one month at a
// time, and picking a month/year drops straight back into the day grid.
function renderDatePicker() {
  const { mode } = datePickerState;
  if (mode === 'months') renderDatePickerMonthGrid();
  else if (mode === 'years') renderDatePickerYearGrid();
  else renderDatePickerDayGrid();
}

function renderDatePickerDayGrid() {
  const { viewYear, viewMonth, selectedIso, maxIso, popup } = datePickerState;
  // calendarColumnIndex/calendarWeekdayLabels (defined above, in the
  // Expenses section) apply the same Monday/Sunday week-start setting here
  // as they do to the Expenses calendar view — every date picker in the app
  // (expense date, custom-range from/to, a crypto position's first-received
  // date) shares this one popup, so they all follow the setting together.
  const firstWeekday = calendarColumnIndex(new Date(viewYear, viewMonth, 1).getDay());
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayIso = new Date().toISOString().slice(0, 10);

  let cells = '';
  for (let i = 0; i < firstWeekday; i++) cells += `<span class="date-picker-day date-picker-day-empty"></span>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const disabled = maxIso && iso > maxIso;
    const classes = ['date-picker-day'];
    if (iso === selectedIso) classes.push('selected');
    if (iso === todayIso) classes.push('today');
    cells += `<button type="button" class="${classes.join(' ')}" data-date="${iso}" ${disabled ? 'disabled' : ''}>${day}</button>`;
  }

  popup.innerHTML = `
    <div class="date-picker-header">
      <button type="button" class="date-picker-nav" data-nav="-1" title="Previous month">&#8249;</button>
      <span class="date-picker-title">
        <button type="button" class="date-picker-title-btn" data-action="show-months">${DATE_PICKER_MONTHS[viewMonth]}</button>
        <button type="button" class="date-picker-title-btn" data-action="show-years">${viewYear}</button>
      </span>
      <button type="button" class="date-picker-nav" data-nav="1" title="Next month">&#8250;</button>
    </div>
    <div class="date-picker-weekdays">${calendarWeekdayLabels().map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="date-picker-grid">${cells}</div>
    ${selectedIso ? `<button type="button" class="date-picker-clear">Clear date</button>` : ''}
  `;
}

function renderDatePickerMonthGrid() {
  const { viewYear, viewMonth, popup } = datePickerState;
  const cells = DATE_PICKER_MONTHS
    .map((name, idx) => `<button type="button" class="date-picker-cell${idx === viewMonth ? ' selected' : ''}" data-month="${idx}">${name.slice(0, 3)}</button>`)
    .join('');

  popup.innerHTML = `
    <div class="date-picker-header">
      <button type="button" class="date-picker-nav" data-nav-year="-1" title="Previous year">&#8249;</button>
      <span class="date-picker-title">
        <button type="button" class="date-picker-title-btn" data-action="show-years">${viewYear}</button>
      </span>
      <button type="button" class="date-picker-nav" data-nav-year="1" title="Next year">&#8250;</button>
    </div>
    <div class="date-picker-cell-grid">${cells}</div>
  `;
}

function renderDatePickerYearGrid() {
  const { viewYear, popup } = datePickerState;
  const startYear = viewYear - 5;
  let cells = '';
  for (let y = startYear; y < startYear + 12; y++) {
    cells += `<button type="button" class="date-picker-cell${y === viewYear ? ' selected' : ''}" data-year="${y}">${y}</button>`;
  }

  popup.innerHTML = `
    <div class="date-picker-header">
      <button type="button" class="date-picker-nav" data-nav-year-range="-1" title="Previous years">&#8249;</button>
      <span class="date-picker-title">${startYear}–${startYear + 11}</span>
      <button type="button" class="date-picker-nav" data-nav-year-range="1" title="Next years">&#8250;</button>
    </div>
    <div class="date-picker-cell-grid">${cells}</div>
  `;
}

// The popup is positioned in document coordinates (rect + scroll offset),
// not viewport coordinates, and CSS gives it `position: absolute` rather
// than `fixed` — so it scrolls together with its trigger instead of staying
// pinned to the viewport while the trigger scrolls out from under it. This
// only ever runs once, right after the popup first opens — re-running it on
// every render (e.g. after paging months) let the whole popup jump around
// whenever a longer/shorter month or a different view changed its height;
// pinning the header in place once and letting the grid grow downward from
// there keeps it stable instead.
function positionDatePicker() {
  const { trigger, popup } = datePickerState;
  const rect = trigger.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  const openUpward = rect.bottom + popupRect.height + 6 > window.innerHeight;
  const top = (openUpward ? rect.top - popupRect.height - 6 : rect.bottom + 6) + window.scrollY;
  const left = Math.min(rect.left, window.innerWidth - popupRect.width - 8) + window.scrollX;
  popup.style.top = `${Math.max(8 + window.scrollY, top)}px`;
  popup.style.left = `${Math.max(8, left)}px`;
}

function openDatePicker(trigger) {
  const reopening = datePickerState && datePickerState.trigger === trigger;
  closeDatePicker();
  if (reopening) return;

  const iso = trigger.dataset.date || '';
  const now = new Date();
  const [y, m] = iso ? iso.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1];

  const popup = document.createElement('div');
  popup.className = 'date-picker-popup';
  popup.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      datePickerState.viewMonth += Number(nav.dataset.nav);
      if (datePickerState.viewMonth < 0) { datePickerState.viewMonth = 11; datePickerState.viewYear--; }
      if (datePickerState.viewMonth > 11) { datePickerState.viewMonth = 0; datePickerState.viewYear++; }
      renderDatePicker();
      return;
    }
    const navYear = event.target.closest('[data-nav-year]');
    if (navYear) {
      datePickerState.viewYear += Number(navYear.dataset.navYear);
      renderDatePicker();
      return;
    }
    const navYearRange = event.target.closest('[data-nav-year-range]');
    if (navYearRange) {
      datePickerState.viewYear += Number(navYearRange.dataset.navYearRange) * 12;
      renderDatePicker();
      return;
    }
    if (event.target.closest('[data-action="show-months"]')) {
      datePickerState.mode = 'months';
      renderDatePicker();
      return;
    }
    if (event.target.closest('[data-action="show-years"]')) {
      datePickerState.mode = 'years';
      renderDatePicker();
      return;
    }
    const monthBtn = event.target.closest('[data-month]');
    if (monthBtn) {
      datePickerState.viewMonth = Number(monthBtn.dataset.month);
      datePickerState.mode = 'days';
      renderDatePicker();
      return;
    }
    const yearBtn = event.target.closest('[data-year]');
    if (yearBtn) {
      datePickerState.viewYear = Number(yearBtn.dataset.year);
      datePickerState.mode = 'days';
      renderDatePicker();
      return;
    }
    const dayBtn = event.target.closest('.date-picker-day[data-date]:not([disabled])');
    if (dayBtn) { selectDatePickerDate(dayBtn.dataset.date); return; }
    if (event.target.closest('.date-picker-clear')) selectDatePickerDate('');
  });
  document.body.appendChild(popup);

  datePickerState = { trigger, popup, viewYear: y, viewMonth: m - 1, selectedIso: iso, maxIso: trigger.dataset.max || null, mode: 'days' };
  renderDatePicker();
  positionDatePicker();
  document.addEventListener('pointerdown', onDatePickerOutsideClick, true);
}

// Renders each position as a wrapping block (name + headline value, then a
// row of labeled stats that wraps onto new lines) instead of a wide table —
// so long position lists only ever grow downward, never sideways.
// `fields` may be a static array (same columns for every row) or a function
// of the position (for lists that mix position shapes, e.g. wallet holdings
// alongside staked positions with different stats). `getId`, if given, adds
// a small hide (×) button per row for manually removing individual coins.
// `getEditManualId`, if given, adds a pencil button for editing a single
// manually-added coin in place — only offered for a pure manual position
// (not a merged row combining several sources, which has no single entry to edit).
// `editingManualId`, if it matches a row's manual id, swaps that one row for
// an inline edit form instead of its usual display — editing happens right
// where the position already sits in the list, not in a separate panel.
function renderPositionRows(positions, { mainLabel, mainValue, fields, getId, getManualIds, getEditManualId, editingManualId, getDateEditId, editingDateOnlyId }) {
  return positions
    .map((pos) => {
      const fieldList = typeof fields === 'function' ? fields(pos) : fields;
      const manualIds = getManualIds ? getManualIds(pos) : [];
      const editManualId = getEditManualId ? getEditManualId(pos) : null;
      const dateEditId = getDateEditId ? getDateEditId(pos) : null;

      if (dateEditId && dateEditId === editingDateOnlyId) {
        // A stripped-down version of the manual-edit form above — only a
        // date (and, for an old-enough date, a hand-typed price) is ever
        // editable here, since balance/symbol/name aren't manually entered
        // data for a wallet-derived position; they come straight from the
        // chain.
        const todayIso = new Date().toISOString().slice(0, 10);
        return `
          <div class="position-row position-row-editing">
            <div class="position-row-main">
              <span class="asset-name">${assetIconHtml(pos.symbol)}${pos.symbol} <span class="meta">${pos.name}</span></span>
              <span class="position-row-main-right">
                <button class="save-date-edit-btn" data-position-id="${dateEditId}" title="${t('edit.saveChanges')}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M4 12.5l5 5L20 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <button class="cancel-date-edit-btn" title="${t('common.cancel')}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </span>
            </div>
            <div class="position-row-details">
              <div class="detail-item">
                <span class="detail-label">First Received</span>
                <button type="button" class="edit-field-date-trigger" data-date="" data-max="${todayIso}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="2" />
                    <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                  </svg>
                  <span class="edit-field-date-trigger-label">${formatDatePickerDisplay('')}</span>
                </button>
              </div>
              <div class="detail-item detail-item-full">
                <span class="detail-label">${pos.coinId ? 'Relink Asset (optional)' : 'Link to Asset'}</span>
                <input type="url" class="edit-field-coingecko-url" placeholder="coingecko.com/en/coins/…" />
              </div>
              <div class="detail-item detail-item-full edit-field-purchase-price-wrap" style="display:none">
                <span class="detail-label">Price per Coin at Purchase (USD)</span>
                <input type="number" step="any" min="0" class="edit-field-purchase-price" placeholder="e.g. 42.50" />
              </div>
            </div>
            <p class="avanza-note" style="margin-top:8px">
              ${pos.coinId
                ? 'Price, P&amp;L, and Change come from CoinGecko automatically for a date within the last year — leave the link blank to keep the current source, or paste a new one to replace it.'
                : 'No CoinGecko link on file — paste one to price this position automatically for a date within the last year, or leave it blank and enter a price per coin by hand.'}
              A purchase over a year ago is outside CoinGecko’s free-tier history lookup, so its price per coin is entered above instead.
            </p>
          </div>
        `;
      }

      if (editManualId && editManualId === editingManualId) {
        // Edits happen right in the row's own stat grid — same layout as the
        // display view, just with Balance/First Received as inputs — instead
        // of swapping the whole row for a separate form. Current Price, P&L,
        // and Change are never directly editable (they come from CoinGecko),
        // so they're hidden entirely while editing rather than shown
        // read-only — a "Link to asset" field takes their place instead,
        // for attaching or replacing the CoinGecko source those numbers are
        // computed from.
        const hasCoinId = !!pos.coinId;
        const todayIso = new Date().toISOString().slice(0, 10);
        const showPurchasePriceField = isDateOlderThanOneYear(pos.firstReceivedDate);
        return `
          <div class="position-row position-row-editing">
            <div class="position-row-main">
              <span class="asset-name-edit">
                <input type="text" class="edit-field-symbol" value="${pos.symbol || ''}" placeholder="Symbol" maxlength="12" />
                <input type="text" class="edit-field-name" value="${pos.name || ''}" placeholder="Display name" />
              </span>
              <span class="position-row-main-right">
                <button class="save-crypto-edit-btn" data-manual-id="${editManualId}" title="Save changes">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M4 12.5l5 5L20 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <button class="cancel-crypto-edit-btn" title="Cancel">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </span>
            </div>
            <div class="position-row-details">
              <div class="detail-item">
                <span class="detail-label">Balance</span>
                <input type="text" inputmode="decimal" class="edit-field-amount" value="${pos.balance ?? ''}" />
              </div>
              <div class="detail-item">
                <span class="detail-label">First Received</span>
                <button type="button" class="edit-field-date-trigger" data-date="${pos.firstReceivedDate || ''}" data-max="${todayIso}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="2" />
                    <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                  </svg>
                  <span class="edit-field-date-trigger-label">${formatDatePickerDisplay(pos.firstReceivedDate)}</span>
                </button>
              </div>
              <div class="detail-item detail-item-full">
                <span class="detail-label">${hasCoinId ? 'Relink Asset (optional)' : 'Link to Asset'}</span>
                <input type="url" class="edit-field-coingecko-url" placeholder="coingecko.com/en/coins/…" />
              </div>
              <div class="detail-item detail-item-full edit-field-purchase-price-wrap" style="${showPurchasePriceField ? '' : 'display:none'}">
                <span class="detail-label">Price per Coin at Purchase (USD)</span>
                <input type="number" step="any" min="0" class="edit-field-purchase-price" value="${pos.priceAtFirstReceived ?? ''}" placeholder="e.g. 42.50" />
              </div>
            </div>
            <p class="avanza-note" style="margin-top:8px">
              ${hasCoinId
                ? 'Price, P&amp;L, and Change come from CoinGecko automatically — leave the link blank to keep the current source, or paste a new one to replace it.'
                : 'No CoinGecko link on file — paste one to start pricing this position automatically, or leave it blank to keep the last known value.'}
              ${showPurchasePriceField ? ' A purchase over a year ago is outside CoinGecko’s free-tier history lookup, so its price per coin is entered above instead.' : ''}
            </p>
          </div>
        `;
      }

      return `
        <div class="position-row">
          <div class="position-row-main">
            <span class="asset-name">${mainLabel(pos)}</span>
            <span class="position-row-main-right">
              ${editManualId ? `
                <button class="position-edit-btn" data-edit-manual-id="${editManualId}" title="Edit this manually-added asset">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M4 20h4l10.5-10.5a2.83 2.83 0 0 0-4-4L4 16v4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    <path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              ` : ''}
              ${manualIds.length ? `
                <button class="position-delete-btn" data-delete-manual-ids="${manualIds.join(',')}" title="Delete this manually-added asset from your account">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              ` : ''}
              ${getId ? `<button class="position-hide-btn" data-hide-id="${getId(pos)}" title="Hide this position">&times;</button>` : ''}
              <span class="position-value">${mainValue(pos)}</span>
            </span>
          </div>
          <div class="position-row-details">
            ${fieldList
              .map(
                (f) => `
                  <div class="detail-item">
                    <span class="detail-label">${f.label}</span>
                    <span class="${f.className ? f.className(pos) : ''}">${f.value(pos)}</span>
                  </div>
                `
              )
              .join('')}
          </div>
        </div>
      `;
    })
    .join('');
}

function shortId(str, front = 6, back = 4) {
  return `${str.slice(0, front)}…${str.slice(-back)}`;
}

// Stable per-position id used for the manual hide/unhide feature — has to
// survive re-fetching the same address, so it's built from on-chain
// identifiers (contract/mint/stake account) rather than array position.
function cryptoPositionId(pos) {
  if (pos.kind === 'staked-sol') return `sol-stake-${pos.stakeAccount}`;
  if (pos.kind === 'sol-liquid') return `sol-liquid-${pos.mint || 'native'}`;
  if (pos.kind === 'simple-chain') return `${pos.chainId}-${pos.symbol}`;
  if (pos.kind === 'manual') return `manual-${pos.manualId}`;
  return `wallet-${pos.contractAddress || pos.symbol}`;
}

// Recomputes P&L for a position given a (possibly overridden) cost-basis
// price — same formula the server uses per-chain, just run client-side so an
// override can update the numbers without a fresh fetch.
function withRecomputedGain(pos, priceAtFirstReceived) {
  if (priceAtFirstReceived == null) return pos;
  const costBasis = priceAtFirstReceived * (pos.balance || 0);
  const gainAbsolute = pos.currentValue != null ? pos.currentValue - costBasis : null;
  const gainPercent = gainAbsolute != null && costBasis > 0 ? (gainAbsolute / costBasis) * 100 : null;
  return { ...pos, priceAtFirstReceived, gainAbsolute, gainPercent };
}

// Applies costBasisOverrides to a freshly-fetched wallet position, in two
// directions:
//  - the chain found a first-received date, but CoinGecko couldn't price it
//    this time (most commonly because that date is now >365 days old, past
//    the free-tier history lookup) — reuse whatever price was successfully
//    cached the first time this exact date was priced, instead of losing the
//    cost basis forever once a year goes by.
//  - the chain found a fresh, successfully-priced date — trust it, and
//    (re)save it to the cache so it's available as that fallback later.
//  - the chain found no date at all — fall back entirely to a date+price the
//    user set by hand via "Set date" (see the .set-date-btn handler below).
function applyCostBasisOverride(pos) {
  const id = cryptoPositionId(pos);
  const cached = costBasisOverrides[id];

  if (pos.firstReceivedDate) {
    if (pos.priceAtFirstReceived != null) {
      if (!cached || cached.firstReceivedDate !== pos.firstReceivedDate || cached.priceAtFirstReceived !== pos.priceAtFirstReceived) {
        costBasisOverrides[id] = { firstReceivedDate: pos.firstReceivedDate, priceAtFirstReceived: pos.priceAtFirstReceived };
        saveCostBasisOverrides();
      }
      return pos;
    }
    return cached && cached.firstReceivedDate === pos.firstReceivedDate
      ? withRecomputedGain(pos, cached.priceAtFirstReceived)
      : pos;
  }

  if (!cached) return pos;
  const withDate = { ...pos, firstReceivedDate: cached.firstReceivedDate };
  return cached.priceAtFirstReceived != null ? withRecomputedGain(withDate, cached.priceAtFirstReceived) : withDate;
}

// Offers the "Set date" row action only for a position the chain couldn't
// date at all — a pure manual entry already has its own full pencil-edit
// form (with a date field of its own), and a merged row combines several
// sources into one, so there's no single position left to attach a date to.
function getDateEditId(pos) {
  if (pos.firstReceivedDate || pos.kind === 'manual' || pos.kind === 'merged') return null;
  return cryptoPositionId(pos);
}

// The same coin often shows up more than once — e.g. native LTC plus
// Binance-Peg LTC on BSC, or liquid ETH plus staked ETH — so positions are
// grouped by symbol and summed into a single row before rendering. Grouping
// happens after the hidden-position filter and doesn't touch the portfolio
// totals above, which are computed from the flat, ungrouped position list.
// A staked position (e.g. staked SOL) is just the same coin locked up rather
// than a different asset, so by default it's merged into the same row as its
// liquid counterpart here like any other same-symbol group (the Settings
// page's "Staked crypto positions" toggle can split it into its own group
// instead — see groupPositionsBySymbol). Cost/gain/change are recomputed
// from the group's own known-cost-basis members rather than carried over
// from a single source, so a merge doesn't silently drop the numbers to N/A.
function mergePositionGroup(group) {
  if (group.length === 1) return group[0];

  const balance = group.reduce((s, p) => s + (p.balance || 0), 0);
  const currentValue = group.reduce((s, p) => s + (p.currentValue ?? 0), 0);
  const currentPrice = group.find((p) => p.currentPrice != null)?.currentPrice ?? null;
  const knownGain = group.filter((p) => p.gainAbsolute != null && p.priceAtFirstReceived != null);
  const gainAbsolute = knownGain.length ? knownGain.reduce((s, p) => s + p.gainAbsolute, 0) : null;
  const costBasis = knownGain.reduce((s, p) => s + p.priceAtFirstReceived * p.balance, 0);
  const gainPercent = knownGain.length && costBasis > 0 ? (gainAbsolute / costBasis) * 100 : null;

  const knownDates = group.map((p) => p.firstReceivedDate).filter(Boolean);
  const firstReceivedDate = knownDates.length ? knownDates.sort()[0] : null;

  return {
    kind: 'merged',
    symbol: group[0].symbol,
    name: `Combined · ${group.length} sources`,
    balance,
    currentPrice,
    currentValue,
    gainAbsolute,
    gainPercent,
    firstReceivedDate,
    breakdown: group
  };
}

// The only explicit staked marker carried client-side is Solana's `kind`
// (see loadWalletAddress) — every other chain's staked position (currently
// just Kiln's staked ETH) only ever surfaces it through its name, so that's
// matched too rather than special-casing each chain individually.
function isStakedPosition(pos) {
  return pos.kind === 'staked-sol' || /staked/i.test(pos.name || '');
}

function groupPositionsBySymbol(positions) {
  const bySymbol = new Map();
  for (const pos of positions) {
    // Settings page: "Staked crypto positions" — merged (default) groups
    // staked and liquid balances of the same coin into one row; separate
    // splits them into their own rows by adding the staked/liquid split to
    // the grouping key itself.
    const key = mergeStakedPositions
      ? pos.symbol.toUpperCase()
      : `${pos.symbol.toUpperCase()}::${isStakedPosition(pos) ? 'staked' : 'liquid'}`;
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(pos);
  }
  return [...bySymbol.values()].map(mergePositionGroup);
}

// A manually-added coin's "current price" is just its stored value divided
// by its amount (that value is itself kept fresh from CoinGecko — see
// refreshManualCryptoPrices and the edit-save handler below, for coins that
// carry a `coinId`). Cost basis (priceAtFirstReceived) is filled in the same
// way, from whatever date the user picked as "first received" — so gain/loss
// comes out the same shape as an on-chain position instead of always N/A.
function manualPositionToPosition(manual) {
  const currentPrice = manual.amount > 0 ? manual.value / manual.amount : null;
  const costBasis = manual.priceAtFirstReceived != null ? manual.priceAtFirstReceived * manual.amount : null;
  const gainAbsolute = costBasis != null ? manual.value - costBasis : null;
  const gainPercent = costBasis > 0 ? (gainAbsolute / costBasis) * 100 : null;

  return {
    kind: 'manual',
    manualId: manual.id,
    coinId: manual.coinId || null,
    symbol: manual.symbol,
    name: manual.name || manual.symbol,
    balance: manual.amount,
    currentPrice,
    currentValue: manual.value,
    firstReceivedDate: manual.firstReceivedDate || null,
    priceAtFirstReceived: manual.priceAtFirstReceived ?? null,
    gainPercent,
    gainAbsolute
  };
}

// True for a manual position itself, or for a merged row that combined a
// manual entry with one or more on-chain positions of the same symbol.
function isManualPosition(pos) {
  if (pos.kind === 'manual') return true;
  return pos.kind === 'merged' && pos.breakdown.some((p) => p.kind === 'manual');
}

// Renders manually-logged crypto sales as their own labeled block, same
// visual shape as buildRealizedPnlSectionHtml's Avanza rows, but with its
// own row markup rather than reusing renderPositionRows — a logged sale is
// user-entered data with a real delete action, not a hide/edit-in-place
// broker position, so it doesn't fit that helper's hook shape. Unlike the
// Avanza version, this always renders (even with zero sales) with a
// "+ Log a sale" jump-link in its header — the actual form lives in the
// sidebar's Add Account panel (id="crypto-sale-form"), but people look for
// "add a sale" right next to their positions, not in a separate panel, so
// this jumps down to it (see the #crypto-jump-to-log-sale-btn handler).
function buildCryptoRealizedSectionHtml(sales) {
  const headerHtml = `
    <div class="avanza-account-section-header">
      <div><h5>${t('stat.realizedPnl')}</h5></div>
      <button type="button" id="crypto-jump-to-log-sale-btn" class="link-btn">+ ${t('crypto.logSaleToggle')}</button>
    </div>
  `;

  if (!sales || !sales.length) {
    return `<div class="realized-pnl-section">${headerHtml}</div>`;
  }

  const rowsHtml = sales
    .map((sale) => {
      const realizedPnl = (sale.sellPrice - sale.buyPrice) * sale.volume;
      const realizedPnlPercent = sale.buyPrice > 0 ? ((sale.sellPrice - sale.buyPrice) / sale.buyPrice) * 100 : null;
      return `
        <div class="position-row">
          <div class="position-row-main">
            <span class="asset-name">${assetIconHtml(sale.symbol)}${sale.symbol}</span>
            <span class="position-row-main-right">
              <button class="position-delete-btn crypto-sale-delete-btn" data-sale-id="${sale.id}" title="Delete this logged sale">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <span class="position-value"><span class="${gainClass(realizedPnl)}">${fmtUSD(realizedPnl)}</span></span>
            </span>
          </div>
          <div class="position-row-details">
            <div class="detail-item"><span class="detail-label">${t('stat.soldDate')}</span><span>${sale.soldDate}</span></div>
            <div class="detail-item"><span class="detail-label">${t('stat.shares')}</span><span>${sale.volume}</span></div>
            <div class="detail-item"><span class="detail-label">${t('stat.avgBuyPrice')}</span><span>${fmtUSD(sale.buyPrice)}</span></div>
            <div class="detail-item"><span class="detail-label">${t('stat.sellPrice')}</span><span>${fmtUSD(sale.sellPrice)}</span></div>
            <div class="detail-item"><span class="detail-label">${t('stat.change')}</span><span class="${gainClass(realizedPnlPercent)}">${fmtPct(realizedPnlPercent)}</span></div>
          </div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="realized-pnl-section">
      ${headerHtml}
      <div class="positions-rows">${rowsHtml}</div>
    </div>
  `;
}

function buildCryptoPortfolioCardSpec() {
  const rawPositions = [
    ...Object.values(cryptoSources).flatMap((source) => source.positions || []).map(applyCostBasisOverride),
    ...manualCryptoPositions.map(manualPositionToPosition)
  ];

  const hiddenCount = rawPositions.filter((p) => hiddenPositionIds.has(cryptoPositionId(p))).length;
  const allPositions = rawPositions.filter((p) => !hiddenPositionIds.has(cryptoPositionId(p)));

  const totalCurrentValue = allPositions.reduce((s, p) => s + (p.currentValue ?? 0), 0);
  const knownGain = allPositions.filter((p) => p.gainAbsolute != null);
  // Cost is summed only from positions with a known cost basis — same as
  // mergePositionGroup does per-row for each position's own % Change — never
  // from a position's current value standing in for an unknown cost.
  const totalCost = knownGain.reduce((s, p) => s + ((p.currentValue ?? 0) - p.gainAbsolute), 0);
  // Gain/Loss and Return are derived from Current Value and Cost (rather
  // than summed independently) so the four headline numbers always
  // reconcile: Current Value − Cost = Gain/Loss, Gain/Loss ÷ Cost = Return.
  // Since Cost only covers the known positions, any position without a
  // historical price effectively counts its whole current value as gain
  // here — see the coverage count and disclaimer below.
  const totalGain = totalCurrentValue - totalCost;
  const totalPct  = totalCost > 0 ? (totalGain / totalCost) * 100 : null;

  // Cost is the only one of these three stats with partial coverage — it
  // only sums positions that got a historical price (ETH, Solana, Litecoin,
  // Stellar, XRP, TON — see server.js). BNB Smart Chain, Optimism, and NEAR
  // still have no cost-basis data since discovering their transaction
  // history needs a paid explorer API, so they fall entirely into Gain/Loss
  // (and Current Value) with an assumed cost of $0.
  const coverageLabel = tCoverageLabel(knownGain.length, allPositions.length);

  const totalRealizedPnl = manualCryptoSales.reduce((s, sale) => s + (sale.sellPrice - sale.buyPrice) * sale.volume, 0);

  const cardsHtml = `
    <div class="stats-cards">
      <div class="stat-card">
        <div class="stat-label">${t('stat.currentValue')}</div>
        <div class="stat-value">${fmtUSD(totalCurrentValue)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('stat.cost')}${coverageLabel}</div>
        <div class="stat-value">${totalCost > 0 ? fmtUSD(totalCost) : 'N/A'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('stat.openPnl')}</div>
        <div class="stat-value ${gainClass(totalGain)}">${knownGain.length ? fmtUSD(totalGain) : 'N/A'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('stat.totalReturn')}</div>
        <div class="stat-value ${gainClass(totalPct)}">${fmtPct(totalPct)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('stat.realizedPnl')}</div>
        <div class="stat-value ${gainClass(totalRealizedPnl)}">${manualCryptoSales.length ? fmtUSD(totalRealizedPnl) : 'N/A'}</div>
      </div>
    </div>
  `;

  // Highest-value coin first; unpriced positions (currentValue == null) sink
  // to the bottom rather than being treated as worthless.
  const displayPositions = groupPositionsBySymbol(allPositions).sort(
    (a, b) => (b.currentValue ?? -Infinity) - (a.currentValue ?? -Infinity)
  );

  // Every coin shows the same 5 stats, in the same order, regardless of
  // chain or position kind — chain-specific extras (validator, stake
  // account, staked status, merged-group sources, historical price) are
  // deliberately left off this table.
  const rowsHtml = renderPositionRows(displayPositions, {
    mainLabel: (pos) => {
      const badge = isManualPosition(pos) ? `<span class="manual-badge">${t('common.addedManually')}</span>` : '';
      const symbol = pos.kind === 'staked-sol' ? 'SOL' : pos.symbol;
      const label = pos.kind === 'staked-sol'
        ? `SOL <span class="meta">staked</span>${badge}`
        : `${pos.symbol} <span class="meta">${pos.name}</span>${badge}`;
      return `${assetIconHtml(symbol)}${label}`;
    },
    mainValue: (pos) => (pos.currentValue != null ? fmtUSD(pos.currentValue) : 'N/A'),
    getId: (pos) => (pos.kind === 'merged' ? pos.breakdown.map(cryptoPositionId).join('|') : cryptoPositionId(pos)),
    // Only manually-added coins can be deleted outright (they're the only
    // ones actually stored anywhere) — on-chain positions can only be hidden,
    // since there's nothing in the database to delete for those.
    getManualIds: (pos) => {
      if (pos.kind === 'manual') return [pos.manualId];
      if (pos.kind === 'merged') return pos.breakdown.filter((p) => p.kind === 'manual').map((p) => p.manualId);
      return [];
    },
    // Only a pure (unmerged) manual entry can be edited in place — a merged
    // row combines several sources into one number, so there's no single
    // manual entry left to hand back to the form.
    getEditManualId: (pos) => (pos.kind === 'manual' ? pos.manualId : null),
    editingManualId: editingManualCryptoId,
    getDateEditId,
    editingDateOnlyId,
    fields: [
      { label: t('stat.balance'), value: (p) => fmtBalance(p.balance) },
      {
        label: t('stat.firstReceived'),
        value: (p) => {
          if (p.firstReceivedDate) return p.firstReceivedDate;
          const id = getDateEditId(p);
          return id ? `<button type="button" class="set-date-btn" data-position-id="${id}">${t('common.setDate')}</button>` : 'N/A';
        }
      },
      { label: t('stat.currentPrice'), value: (p) => fmtUSD(p.currentPrice) },
      {
        label: t('stat.unrealizedPnl'),
        value: (p) => (p.gainAbsolute != null ? fmtUSD(p.gainAbsolute) : 'N/A'),
        className: (p) => gainClass(p.gainAbsolute)
      },
      { label: t('stat.change'), value: (p) => fmtPct(p.gainPercent), className: (p) => gainClass(p.gainPercent) }
    ]
  });

  // Addresses are only ever shown once the card is expanded into its full
  // table (see the wallet-addresses block in detailHtml below) — the always-
  // visible card header just says how many sources are connected.
  const sourcesWithAddress = Object.values(cryptoSources).filter((source) => source.address);
  const meta = sourcesWithAddress.length
    ? (currentLanguage === 'ru' ? `Подключено кошельков: ${sourcesWithAddress.length}`
      : currentLanguage === 'zh' ? `已连接 ${sourcesWithAddress.length} 个钱包`
      : `${sourcesWithAddress.length} wallet${sourcesWithAddress.length === 1 ? '' : 's'} connected`)
    : t('card.noSourcesLoaded');

  const addressesHtml = sourcesWithAddress.length
    ? `
      <div class="wallet-addresses">
        ${sourcesWithAddress
          .map((source) => `<span class="wallet-address" title="${source.address}">${shortId(source.address)}</span>`)
          .join('')}
      </div>
    `
    : '';

  const unhideHtml = hiddenCount
    ? `<p class="avanza-note" style="margin-top:10px">${tPositionsHidden(hiddenCount)} — <button class="link-btn" data-action="unhide-crypto">${t('card.showAll')}</button></p>`
    : '';

  const detailHtml = `
    ${addressesHtml}
    ${cardsHtml}
    <div class="positions-rows">${rowsHtml}</div>
    ${unhideHtml}
    ${buildCryptoRealizedSectionHtml(manualCryptoSales)}
    <p class="avanza-note" style="margin-top:14px">&ast; ${t('card.cryptoDisclaimer')}</p>
  `;

  return {
    id: 'crypto-portfolio',
    title: t('card.cryptoPortfolio'),
    icon: accountTypeIconHtml('wallet'),
    meta: meta || t('card.noSourcesLoaded'),
    badgeLabel: 'crypto · live',
    headlineValue: fmtUSD(totalCurrentValue),
    headlineSub: totalPct != null ? fmtPct(totalPct) : null,
    headlineSubClass: gainClass(totalPct),
    detailHtml,
    footerNote: cryptoSnapshotUpdatedAt
      ? `${t('card.walletStakedPositions')} · ${t('common.lastUpdated').toLowerCase()} ${formatLastUpdated(cryptoSnapshotUpdatedAt)}`
      : t('card.walletStakedPositions'),
    currentValue: totalCurrentValue,
    currency: 'USD',
    removeId: 'crypto-portfolio',
    removeKind: 'live'
  };
}

// ── Avanza integration ──────────────────────────────────────────────────────

const avanzaLogin          = document.getElementById('avanza-login');
const avanzaWaiting        = document.getElementById('avanza-waiting');
const avanzaConnected      = document.getElementById('avanza-connected');
const avanzaForm           = document.getElementById('avanza-form');
const avanzaAccountsLabel  = document.getElementById('avanza-accounts-label');
const avanzaRefreshBtn     = document.getElementById('avanza-refresh-btn');
const avanzaDisconnectBtn  = document.getElementById('avanza-disconnect-btn');

const avanzaBankidChooser    = document.getElementById('avanza-bankid-chooser');
const avanzaBankidStartBtn   = document.getElementById('avanza-bankid-start-btn');
const avanzaTogglePasswordBtn = document.getElementById('avanza-toggle-password-btn');
const avanzaBackToBankidBtn  = document.getElementById('avanza-back-to-bankid-btn');
const avanzaWaitingSpinner   = document.getElementById('avanza-waiting-spinner');
const avanzaWaitingQr        = document.getElementById('avanza-waiting-qr');
const avanzaBankidQrImg      = document.getElementById('avanza-bankid-qr');
const avanzaBankidHint       = document.getElementById('avanza-bankid-hint');
const avanzaBankidCancelBtn  = document.getElementById('avanza-bankid-cancel-btn');

// Called (from loadProfileAndRestore) only when the vault handed back a
// stored avanzaSession — attempts to use it live. loadAllAvanzaAccounts
// itself clears avanzaSession on a real 401 (so a dead session doesn't just
// fail the same way forever) and otherwise reports its own errors, so
// there's nothing left for this wrapper to do beyond picking the view and
// delegating.
async function checkAvanzaStatus() {
  await withLoading(async () => {
    showAvanzaView('connected');
    await loadAllAvanzaAccounts();
  });
}

// The login view toggles between the BankID QR chooser and the username/
// password form — only one Avanza account is connected at a time, so only
// one of these is ever in play.
avanzaTogglePasswordBtn.addEventListener('click', () => {
  avanzaBankidChooser.style.display = 'none';
  avanzaForm.style.display = '';
});

avanzaBackToBankidBtn.addEventListener('click', () => {
  avanzaForm.style.display = 'none';
  avanzaBankidChooser.style.display = '';
});

avanzaForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const username = document.getElementById('avanza-username').value.trim();
  const password = document.getElementById('avanza-password').value;
  const totp = document.getElementById('avanza-totp').value.trim();

  showAvanzaView('waiting', 'spinner');

  withLoading(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, totp }),
        signal: AbortSignal.timeout(30_000)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Authentication failed.');

      avanzaSession = data.session;
      syncProfileToServer();
      showAvanzaView('connected');
      await loadAllAvanzaAccounts();
    } catch (err) {
      showAvanzaView('login');
      alert(
        err.name === 'TimeoutError'
          ? 'Login request timed out. Please try again.'
          : `Failed to connect: ${err.message}`
      );
    }
  });
});

// ── BankID QR login ──────────────────────────────────────────────────────
// Polls /api/auth/bankid/poll every couple of seconds; each response carries
// both a freshly-rotated QR image and the current approval status, so one
// loop handles both keeping the code on screen alive and detecting completion.
// The relay tracks each in-flight scan by flowId (rather than one shared
// session, which only worked for the original single-user server — see
// server.js) — this is that flow's id for the current scan attempt.
let bankidPollTimer = null;
let bankidFlowId = null;

function stopBankidPolling() {
  if (bankidPollTimer) {
    clearTimeout(bankidPollTimer);
    bankidPollTimer = null;
  }
}

avanzaBankidStartBtn.addEventListener('click', () => {
  withLoading(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/bankid/start`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start BankID login.');

      bankidFlowId = data.flowId;
      avanzaBankidQrImg.src = data.qr;
      avanzaBankidHint.textContent = 'Open BankID on your phone and scan the code.';
      showAvanzaView('waiting', 'qr');
      pollBankid();
    } catch (err) {
      alert(`Failed to start BankID login: ${err.message}`);
    }
  });
});

function pollBankid() {
  bankidPollTimer = setTimeout(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/bankid/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowId: bankidFlowId }),
        signal: AbortSignal.timeout(15_000)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'BankID login failed.');

      if (data.done) {
        stopBankidPolling();
        bankidFlowId = null;
        avanzaSession = data.session;
        syncProfileToServer();
        showAvanzaView('connected');
        await withLoading(loadAllAvanzaAccounts);
        return;
      }

      if (data.qr) avanzaBankidQrImg.src = data.qr;
      pollBankid();
    } catch (err) {
      stopBankidPolling();
      bankidFlowId = null;
      showAvanzaView('login');
      alert(`BankID login failed: ${err.message}`);
    }
  }, 1500);
}

avanzaBankidCancelBtn.addEventListener('click', () => {
  stopBankidPolling();
  bankidFlowId = null;
  showAvanzaView('login');
});

avanzaDisconnectBtn.addEventListener('click', () => {
  withLoading(async () => {
    // Purely local now — there's no server-side session for a /api/logout
    // call to tear down (see server.js: the relay never held one to begin
    // with), just this vault's own copy of it.
    avanzaSession = null;
    showAvanzaView('login');
    avanzaForm.reset();
    avanzaSummaries.clear();
    avanzaSnapshotPayload = null;
    syncProfileToServer();
    liveAccounts = liveAccounts.filter((a) => a.id !== 'avanza-group');
    render();
  });
});

avanzaRefreshBtn.addEventListener('click', () => withLoading(loadAllAvanzaAccounts));

function showAvanzaView(view, waitingSubView) {
  avanzaLogin.style.display     = view === 'login'     ? '' : 'none';
  avanzaWaiting.style.display   = view === 'waiting'   ? '' : 'none';
  avanzaConnected.style.display = view === 'connected' ? '' : 'none';

  if (view === 'waiting') {
    avanzaWaitingSpinner.style.display = waitingSubView === 'spinner' ? '' : 'none';
    avanzaWaitingQr.style.display      = waitingSubView === 'qr'      ? '' : 'none';
  }
}

// accountId -> last-fetched { account, positions, summary } for every
// connected Avanza account, merged into one "Avanza" card (see
// buildAvanzaGroupCardSpec) so the whole group can be rebuilt (e.g. on a
// display-currency change) without hitting the API again.
const avanzaSummaries = new Map();

// The exact { updatedAt, accounts } payload last known to be correct on the
// server for this profile's Avanza data. Every profile sync (see
// syncProfileToServer) sends this value as-is — it's only ever reassigned at
// a handful of well-defined moments below (a fresh live load, an explicit
// disconnect, or whatever the server already had on login) — rather than
// being recomputed from avanzaSummaries at send-time. avanzaSummaries starts
// empty on every page load and is only repopulated by a live reload or the
// restore-on-login step, so recomputing it on the fly meant *any* unrelated
// save (e.g. adding a wallet) that happened to fire first would send
// `avanzaSnapshot: null` and the server's full-replace PUT would wipe out an
// otherwise perfectly good saved snapshot.
let avanzaSnapshotPayload = null;

// The live Avanza session — {securityToken, authenticationSession, cookies}
// — needed on every /api/overview or /api/stats call now that the relay
// holds no session of its own (see server.js). Restored from the vault's
// avanzaSession field on unlock (loadProfileAndRestore) and persisted back
// the same way, so a returning visitor isn't forced through BankID/TOTP
// again every single time the way the original single-user app's
// server-memory-only session required.
let avanzaSession = null;

function avanzaSessionHeader() {
  return avanzaSession ? { 'X-Avanza-Session': btoa(JSON.stringify(avanzaSession)) } : {};
}

function formatLastUpdated(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// Fetches every account under the connected Avanza login and loads each
// one's statistics — no manual per-account selection step. Each account's
// fetch is independent (Promise.allSettled) so one account erroring out
// (e.g. a stats endpoint hiccup) doesn't block the rest.
async function loadAllAvanzaAccounts() {
  avanzaRefreshBtn.disabled = true;
  avanzaRefreshBtn.textContent = 'Loading…';
  avanzaAccountsLabel.textContent = 'Fetching accounts…';

  if (!avanzaSession) {
    avanzaRefreshBtn.disabled = false;
    avanzaRefreshBtn.textContent = 'Refresh accounts';
    showAvanzaView('login');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/overview`, { headers: avanzaSessionHeader() });
    const overview = await res.json();
    if (res.status === 401) {
      // The session the vault handed us is no longer valid — clear it so
      // this doesn't just fail the same way again next load, and drop back
      // to the login view rather than showing a stale "connected" state.
      avanzaSession = null;
      syncProfileToServer();
      showAvanzaView('login');
      return;
    }
    if (!res.ok) throw new Error(overview.error || 'Failed to load accounts.');
    const accs = overview.accounts || [];

    const results = await Promise.allSettled(accs.map((a) => loadStats(a.accountId)));
    const failures = results.filter((r) => r.status === 'rejected');

    if (avanzaSummaries.size) {
      avanzaSnapshotPayload = { updatedAt: new Date().toISOString(), accounts: [...avanzaSummaries.values()] };
      syncProfileToServer();
    }
    refreshAvanzaCard();
    render();

    avanzaAccountsLabel.textContent = failures.length
      ? `${accs.length - failures.length}/${accs.length} account${accs.length === 1 ? '' : 's'} loaded (${failures.length} failed)`
      : `${accs.length} account${accs.length === 1 ? '' : 's'} loaded`;
  } catch (err) {
    avanzaAccountsLabel.textContent = err.message || 'Failed to load accounts.';
  } finally {
    avanzaRefreshBtn.disabled = false;
    avanzaRefreshBtn.textContent = 'Refresh accounts';
  }
}

async function loadStats(accountId) {
  const res = await fetch(`${API_BASE}/api/stats/${accountId}`, { headers: avanzaSessionHeader() });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error);
  }
  const statsData = await res.json();
  avanzaSummaries.set(accountId, statsData);
}

// Rebuilds the single Avanza card from every cached account summary, same
// rationale as refreshCryptoPortfolioCard — used when the display currency
// changes, or right after (re)loading accounts. Removes the card entirely
// once no account clears the dust threshold (e.g. right after disconnect).
function refreshAvanzaCard() {
  const spec = buildAvanzaGroupCardSpec();
  const idx = liveAccounts.findIndex((a) => a.id === 'avanza-group');
  if (spec) {
    if (idx >= 0) liveAccounts[idx] = spec;
    else liveAccounts = [spec, ...liveAccounts];
  } else if (idx >= 0) {
    liveAccounts = liveAccounts.filter((a) => a.id !== 'avanza-group');
  }
  scheduleNewsRefresh();
}

function fmtCurrency(value, currency = 'SEK') {
  return formatMoney(convertToDisplayCurrency(value, currency), displayCurrency);
}

function fmtPct(value) {
  if (value == null) return 'N/A';
  const sign = value >= 0 ? '+' : '';
  return maskIfPrivate(applyDecimalSeparator(`${sign}${value.toFixed(numberDecimals)}%`));
}

function gainClass(value) {
  if (value == null) return '';
  return value >= 0 ? 'gain' : 'loss';
}

// Accounts this close to zero (e.g. a stray 0.78 SEK savings account) just
// clutter the Avanza card with entries that read as "$0" — hide them,
// same idea as isMeaningfulValue for manual accounts.
const AVANZA_DUST_THRESHOLD_SEK = 1;

// Renders sold trades (closed positions) as their own labeled block below
// the open positions — reuses renderPositionRows so a closed trade looks
// like an open one, just with sold-specific columns. Returns '' when there
// are no closed trades yet, so the block doesn't show up empty.
function buildRealizedPnlSectionHtml(closedPositions) {
  if (!closedPositions || !closedPositions.length) return '';

  const rowsHtml = renderPositionRows(closedPositions, {
    mainLabel: (pos) => `${assetIconHtml(pos.name)}${pos.name}`,
    mainValue: (pos) => `<span class="${gainClass(pos.realizedPnl)}">${pos.realizedPnl != null ? fmtCurrency(pos.realizedPnl, pos.currency) : 'N/A'}</span>`,
    fields: [
      { label: t('stat.soldDate'), value: (pos) => pos.soldDate || 'N/A' },
      { label: t('stat.shares'), value: (pos) => pos.volume },
      { label: t('stat.avgBuyPrice'), value: (pos) => (pos.avgBuyPrice != null ? fmtCurrency(pos.avgBuyPrice, pos.currency) : 'N/A') },
      { label: t('stat.sellPrice'), value: (pos) => (pos.sellPrice != null ? fmtCurrency(pos.sellPrice, pos.currency) : 'N/A') },
      { label: t('stat.change'), value: (pos) => fmtPct(pos.realizedPnlPercent), className: (pos) => gainClass(pos.realizedPnlPercent) }
    ]
  });

  return `
    <div class="realized-pnl-section">
      <h5>${t('stat.realizedPnl')}</h5>
      <div class="positions-rows">${rowsHtml}</div>
    </div>
  `;
}

// Renders one account's stats-cards + position rows — a sub-section inside
// the single combined Avanza card, not a card of its own.
function buildAvanzaAccountSectionHtml({ account, positions, summary, closedPositions }) {
  const cardsHtml = `
    <div class="stats-cards">
      <div class="stat-card">
        <div class="stat-label">${t('stat.currentValue')}</div>
        <div class="stat-value">${fmtCurrency(summary.totalCurrentValue)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('stat.totalInvested')}</div>
        <div class="stat-value">${summary.totalCost > 0 ? fmtCurrency(summary.totalCost) : 'N/A'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('stat.openPnl')}</div>
        <div class="stat-value ${gainClass(summary.totalGain)}">
          ${summary.totalGain != null ? fmtCurrency(summary.totalGain) : 'N/A'}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('stat.totalReturn')}</div>
        <div class="stat-value ${gainClass(summary.totalGainPercent)}">
          ${fmtPct(summary.totalGainPercent)}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('stat.realizedPnl')}</div>
        <div class="stat-value ${gainClass(summary.totalRealizedPnl)}">
          ${closedPositions.length ? fmtCurrency(summary.totalRealizedPnl) : 'N/A'}
        </div>
      </div>
    </div>
  `;

  // Largest holding first, same ordering as the Crypto Portfolio card.
  const sortedPositions = [...positions].sort((a, b) => (b.currentValue ?? -Infinity) - (a.currentValue ?? -Infinity));

  const rowsHtml = renderPositionRows(sortedPositions, {
    mainLabel: (pos) => `${assetIconHtml(pos.name)}${pos.name}`,
    mainValue: (pos) => fmtCurrency(pos.currentValue, pos.currency),
    fields: [
      { label: t('stat.shares'), value: (pos) => pos.volume },
      { label: t('stat.firstBuy'), value: (pos) => pos.firstPurchaseDate || 'N/A' },
      { label: t('stat.avgBuyPrice'), value: (pos) => (pos.avgBuyPrice != null ? fmtCurrency(pos.avgBuyPrice, pos.currency) : 'N/A') },
      { label: t('stat.currentPrice'), value: (pos) => fmtCurrency(pos.currentPrice, pos.currency) },
      { label: t('stat.change'), value: (pos) => fmtPct(pos.gainPercent), className: (pos) => gainClass(pos.gainPercent) },
      {
        label: t('stat.unrealizedPnl'),
        value: (pos) => (pos.gainAbsolute != null ? fmtCurrency(pos.gainAbsolute, pos.currency) : 'N/A'),
        className: (pos) => gainClass(pos.gainAbsolute)
      }
    ]
  });

  return `
    <div class="avanza-account-section">
      <div class="avanza-account-section-header">
        <div class="avanza-account-title">
          <h4>${account.name}</h4>
          <span class="meta">${account.type}</span>
        </div>
        <span class="position-value">${fmtCurrency(summary.totalCurrentValue)}</span>
      </div>
      ${cardsHtml}
      <div class="positions-rows">${rowsHtml}</div>
      ${buildRealizedPnlSectionHtml(closedPositions)}
    </div>
  `;
}

// Merges every connected Avanza account into one "Avanza" card, each
// account rendered as its own sub-section inside — mirrors how the Crypto
// Portfolio card merges positions from several chains into one card.
// Returns null when nothing clears the dust threshold, so the card can be
// removed entirely rather than shown empty.
function buildAvanzaGroupCardSpec() {
  const entries = [...avanzaSummaries.values()]
    .filter((data) => isMeaningfulValue(data.summary.totalCurrentValue, AVANZA_DUST_THRESHOLD_SEK))
    .sort((a, b) => b.summary.totalCurrentValue - a.summary.totalCurrentValue);

  if (!entries.length) return null;

  const totalCurrentValue = entries.reduce((s, e) => s + e.summary.totalCurrentValue, 0);
  const totalCost = entries.reduce((s, e) => s + (e.summary.totalCost || 0), 0);
  const totalGain = entries.reduce((s, e) => s + (e.summary.totalGain || 0), 0);
  const totalGainPercent = totalCost > 0 ? (totalGain / totalCost) * 100 : null;

  const detailHtml = entries.map(buildAvanzaAccountSectionHtml).join('<hr class="panel-divider" />');

  return {
    id: 'avanza-group',
    title: t('card.avanza'),
    icon: accountTypeIconHtml('broker'),
    meta: tAccountsConnected(entries.length),
    badgeLabel: 'avanza · live',
    headlineValue: fmtCurrency(totalCurrentValue),
    headlineSub: totalGainPercent != null ? fmtPct(totalGainPercent) : null,
    headlineSubClass: gainClass(totalGainPercent),
    detailHtml,
    footerNote: avanzaSnapshotPayload?.updatedAt
      ? `${t('card.avanza')} · ${t('common.lastUpdated').toLowerCase()} ${formatLastUpdated(avanzaSnapshotPayload.updatedAt)}`
      : t('card.avanza'),
    currentValue: totalCurrentValue,
    currency: 'SEK',
    removeId: 'avanza-group',
    removeKind: 'live',
    // Reconnecting always requires a fresh BankID/password login (Avanza's
    // session lives only in server memory) — this button lives on the card
    // itself rather than in the "Add account" panel, since it's a refresh of
    // an existing connection, not adding a new one.
    reconnectAction: 'avanza'
  };
}

// ── PayPal integration ──────────────────────────────────────────────────────
// A Business account's balance, read server-side via PayPal's REST API (see
// server.js) — same "server holds the live session, client just calls our
// own API" shape as Avanza above. PayPal has no personal-login equivalent of
// Avanza's BankID/username flow, so there's just the one credentials form,
// no QR/2FA branching.

const paypalLogin          = document.getElementById('paypal-login');
const paypalWaiting        = document.getElementById('paypal-waiting');
const paypalConnected      = document.getElementById('paypal-connected');
const paypalForm           = document.getElementById('paypal-form');
const paypalClientIdInput  = document.getElementById('paypal-client-id');
const paypalClientSecretInput = document.getElementById('paypal-client-secret');
const paypalEnvSelect      = document.getElementById('paypal-env');
const paypalBalanceLabel   = document.getElementById('paypal-balance-label');
const paypalRefreshBtn     = document.getElementById('paypal-refresh-btn');
const paypalDisconnectBtn  = document.getElementById('paypal-disconnect-btn');

enhanceSelect(paypalEnvSelect);

// The last successful balance fetch — {balances, accountId, updatedAt}, or
// null. Restored from the vault's cached snapshot on unlock (see
// loadProfileAndRestore) and persisted back the same way, same as
// avanzaSnapshotPayload.
let paypalSnapshot = null;

// The live PayPal session — {clientId, clientSecret, env, accessToken,
// expiresAt} — resent whole on every balance check now that the relay
// doesn't cache it server-side (see server.js's ensurePaypalToken, which
// takes and returns this shape instead of mutating shared state). Restored
// from the vault's paypalSession field on unlock, persisted back the same
// way (including the refreshed token/expiry the relay may hand back).
let paypalSession = null;

function showPaypalView(view) {
  paypalLogin.style.display     = view === 'login'     ? '' : 'none';
  paypalWaiting.style.display   = view === 'waiting'   ? '' : 'none';
  paypalConnected.style.display = view === 'connected' ? '' : 'none';
}

// Called (from loadProfileAndRestore) only when the vault handed back a
// stored paypalSession — attempts a live balance refresh with it.
// loadPaypalBalance clears paypalSession itself on a real 401.
async function checkPaypalStatus() {
  await withLoading(async () => {
    showPaypalView('connected');
    await loadPaypalBalance();
  });
}

paypalForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const clientId = paypalClientIdInput.value.trim();
  const clientSecret = paypalClientSecretInput.value.trim();
  const env = paypalEnvSelect.value;

  showPaypalView('waiting');

  withLoading(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/paypal/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret, env }),
        signal: AbortSignal.timeout(20_000)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to connect to PayPal.');

      paypalSession = data.session;
      syncProfileToServer();
      showPaypalView('connected');
      applyPaypalBalance(data.balances, data.accountId);
      paypalForm.reset();
    } catch (err) {
      showPaypalView('login');
      alert(
        err.name === 'TimeoutError'
          ? 'Connection to PayPal timed out. Please try again.'
          : `Failed to connect: ${err.message}`
      );
    }
  });
});

async function loadPaypalBalance() {
  if (!paypalSession) {
    showPaypalView('login');
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/paypal/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: paypalSession })
    });
    const data = await res.json();
    if (res.status === 401) {
      // Credentials the vault had are no longer valid — clear them rather
      // than retrying the same failing session forever.
      paypalSession = null;
      syncProfileToServer();
      showPaypalView('login');
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Failed to fetch PayPal balance.');
    // The relay may have refreshed the access token in-request — persist
    // whatever it handed back so the next call doesn't refresh again
    // needlessly.
    paypalSession = data.session || paypalSession;
    syncProfileToServer();
    applyPaypalBalance(data.balances, data.accountId);
  } catch (err) {
    paypalBalanceLabel.textContent = err.message || 'Failed to load PayPal balance.';
  }
}

function applyPaypalBalance(balances, accountId) {
  paypalSnapshot = { balances: balances || [], accountId, updatedAt: new Date().toISOString() };
  paypalBalanceLabel.textContent = tCurrenciesTracked(paypalSnapshot.balances.length);
  syncProfileToServer();
  refreshPaypalCard();
}

// PayPal can hold a balance in more than one currency at once — each becomes
// its own line in the card's detail list, but the headline/portfolio-total
// figure needs one number, so every balance is converted to USD up front
// (same convention every other manual/live value in this app follows) and
// summed.
function buildPaypalCardSpec() {
  if (!paypalSnapshot) return null;
  const balances = paypalSnapshot.balances;
  const totalUSD = balances.reduce(
    (sum, b) => sum + convertToUSD(Number(b.total_balance?.value || 0), b.currency),
    0
  );

  const detailHtml = `
    <ul class="positions-list">
      ${balances
        .map(
          (b) => `
            <li>
              <span>${b.currency}</span>
              <span>${fmtCurrency(Number(b.total_balance?.value || 0), b.currency)}</span>
            </li>
          `
        )
        .join('')}
    </ul>
  `;

  return {
    id: 'paypal-account',
    title: t('card.paypal'),
    icon: accountTypeIconHtml('paypal'),
    meta: paypalSnapshot.accountId || '',
    badgeLabel: 'paypal · live',
    headlineValue: fmtCurrency(totalUSD, 'USD'),
    detailHtml,
    footerNote: paypalSnapshot.updatedAt
      ? `${t('card.paypal')} · ${t('common.lastUpdated').toLowerCase()} ${formatLastUpdated(paypalSnapshot.updatedAt)}`
      : t('card.paypal'),
    currentValue: totalUSD,
    currency: 'USD',
    removeId: 'paypal-account',
    removeKind: 'live',
    // Reconnecting needs the Client ID/Secret again (never persisted, same
    // rationale as Avanza's username/password) — this button lives on the
    // card itself rather than the "Add account" panel, since it's a refresh
    // of an existing connection, not adding a new one.
    reconnectAction: 'paypal'
  };
}

function refreshPaypalCard() {
  const spec = buildPaypalCardSpec();
  const idx = liveAccounts.findIndex((a) => a.id === 'paypal-account');
  if (spec) {
    if (idx >= 0) liveAccounts[idx] = spec;
    else liveAccounts = [spec, ...liveAccounts];
  } else if (idx >= 0) {
    liveAccounts = liveAccounts.filter((a) => a.id !== 'paypal-account');
  }
  render();
}

paypalRefreshBtn.addEventListener('click', () => withLoading(loadPaypalBalance));

paypalDisconnectBtn.addEventListener('click', () => {
  withLoading(async () => {
    // Purely local — the relay never held a PayPal session to disconnect
    // (see server.js), just this vault's own copy of it.
    paypalSession = null;
    showPaypalView('login');
    paypalForm.reset();
    paypalSnapshot = null;
    syncProfileToServer();
    liveAccounts = liveAccounts.filter((a) => a.id !== 'paypal-account');
    render();
  });
});

// ── Vault gate ───────────────────────────────────────────────────────────────
// Blocks the dashboard until the local encrypted vault (see storage.js) is
// unlocked, created fresh, or populated via a one-time import from the
// original (unmodified) Tradone app. Nothing here ever touches a server —
// the vault lives entirely in this browser's IndexedDB, and the passphrase
// that unlocks it is never itself persisted anywhere (see storage.js).

const authGate       = document.getElementById('auth-gate');
const appShell       = document.getElementById('app-shell');
const authHeading    = document.getElementById('auth-heading');
const authSub        = document.getElementById('auth-sub');
const authError      = document.getElementById('auth-error');
const unlockForm     = document.getElementById('unlock-form');
const createForm     = document.getElementById('create-form');
const logoutBtn      = document.getElementById('logout-btn');
const currencyDropdown    = document.getElementById('currency-dropdown');
const currencyDropdownBtn = document.getElementById('currency-dropdown-btn');
const currencyDropdownLabel = document.getElementById('currency-dropdown-label');
const currencyDropdownMenu = document.getElementById('currency-dropdown-menu');
const currencyOptions     = [...currencyDropdownMenu.querySelectorAll('li')];

// 'unlock' — a vault already exists on this device (Log in). 'create' — no
// vault yet, first run on this device (Sign up). English-only for now, same
// as the rest of this gate (a smaller, one-time addition to localize later
// rather than touching all three locale dictionaries for a handful of
// first-run-only strings).
function setGateView(view) {
  unlockForm.style.display = view === 'unlock' ? '' : 'none';
  createForm.style.display = view === 'create' ? '' : 'none';
  authHeading.textContent = view === 'unlock' ? 'Log in' : 'Sign up';
  authSub.textContent = 'Your data is encrypted and stored only on this device.';
  authError.textContent = '';
}

function setCurrencyDropdownOpen(open) {
  currencyDropdown.classList.toggle('open', open);
  currencyDropdownBtn.setAttribute('aria-expanded', String(open));
}

// Re-renders every part of the app that displays a formatted number —
// shared by the currency switcher and the Settings page controls (decimal
// places/separator, staked-position grouping), so a new live-card type only
// ever needs to be added to this one list.
function refreshAllDisplays() {
  updateFlatCurrencyHint();
  updateExpenseCurrencyHint();
  refreshCryptoPortfolioCard();
  refreshAvanzaCard();
  refreshPaypalCard();
  render();
  renderExpenses();
}

function selectCurrency(value) {
  const option = currencyOptions.find((li) => li.dataset.value === value);
  if (!option) return;

  displayCurrency = value;
  localStorage.setItem(CURRENCY_KEY, displayCurrency);
  currencyDropdownLabel.textContent = `${option.dataset.value} ${option.dataset.symbol}`;
  currencyOptions.forEach((li) => li.classList.toggle('selected', li === option));

  refreshAllDisplays();
}

currencyDropdownBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  setCurrencyDropdownOpen(!currencyDropdown.classList.contains('open'));
});

currencyOptions.forEach((li) => {
  li.addEventListener('click', () => {
    selectCurrency(li.dataset.value);
    setCurrencyDropdownOpen(false);
  });
});

document.addEventListener('click', (event) => {
  if (!currencyDropdown.contains(event.target)) setCurrencyDropdownOpen(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setCurrencyDropdownOpen(false);
});

selectCurrency(displayCurrency);

// ── Privacy toggle ────────────────────────────────────────────────────────

const privacyToggleBtn = document.getElementById('privacy-toggle-btn');

function setPrivacyMode(enabled) {
  privacyMode = enabled;
  localStorage.setItem(PRIVACY_KEY, String(privacyMode));
  privacyToggleBtn.setAttribute('aria-pressed', String(privacyMode));
  privacyToggleBtn.title = privacyMode ? 'Show balances' : 'Hide balances';

  refreshCryptoPortfolioCard();
  refreshAvanzaCard();
  render();
}

privacyToggleBtn.addEventListener('click', () => setPrivacyMode(!privacyMode));

setPrivacyMode(privacyMode);

// Rates start as USD-only, so anything already rendered under a non-USD
// display currency was shown unconverted until this resolves.
loadExchangeRates().then(() => {
  refreshCryptoPortfolioCard();
  refreshAvanzaCard();
  render();
});

// ── Page-wide pop-in reveal ──────────────────────────────────────────────
// Called whenever the auth gate or the app shell becomes visible. Every
// text/element in the given container gets a staggered entrance delay based
// on its position on the page, so the reveal sweeps diagonally from the
// upper-left corner toward the lower-right.
const POP_IN_SELECTOR = 'h1, h2, h3, h4, p, label, button, input, select, li, strong, span, svg, .badge, .account-card, .stat-card, .position-row';
const POP_IN_MAX_DELAY_MS = 650;

function playPopInAnimation(root) {
  const all = Array.from(root.querySelectorAll(POP_IN_SELECTOR))
    .filter((el) => el.offsetParent !== null);

  // Keep only the outermost match in each nesting chain, so a card's own
  // heading/text/buttons don't each re-pop independently inside it.
  const targets = all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  if (!targets.length) return;

  const diagonals = targets.map((el) => {
    const rect = el.getBoundingClientRect();
    return rect.top + window.scrollY + rect.left + window.scrollX;
  });
  const maxDiagonal = Math.max(...diagonals, 1);

  targets.forEach((el, i) => {
    const delay = (diagonals[i] / maxDiagonal) * POP_IN_MAX_DELAY_MS;
    el.classList.remove('pop-in');
    void el.offsetWidth; // force reflow so the animation restarts on repeat calls
    el.style.setProperty('--pop-delay', `${delay.toFixed(0)}ms`);
    el.classList.add('pop-in');
    // The animation's `both` fill mode keeps its final keyframe (a non-`none`
    // transform) applied indefinitely once .pop-in is added — which permanently
    // promotes the element to its own stacking context, at which point z-index
    // no longer means what it looks like it means: an unrelated later-DOM-order
    // .pop-in element (e.g. a paragraph below a dropdown) can end up painting
    // over an open dropdown menu despite the menu's own z-index, because
    // they're now competing as separate stacking contexts instead of within a
    // shared one. The reveal is a one-time entrance effect, so drop the class
    // the moment its animation actually finishes to release the side effect.
    el.addEventListener('animationend', () => el.classList.remove('pop-in'), { once: true });
  });
}

function showApp() {
  authGate.style.display = 'none';
  appShell.style.display = '';
  playPopInAnimation(appShell);
}

function showGate() {
  appShell.style.display = 'none';
  authGate.style.display = '';
  playPopInAnimation(authGate);
}

// Writes every profile field into the local encrypted vault (see
// storage.js) — the direct replacement for the old app's whole-profile PUT
// to a server. Kept as one function (same name/shape every other call site
// in this file already calls) so mutating code elsewhere doesn't need to
// change at all, just what happens when it asks to persist.
async function syncProfileToServer() {
  if (!Vault.isUnlocked()) return;
  try {
    // One atomic read-modify-write covering every field — NOT several
    // parallel saveField calls, which would race on the shared IndexedDB
    // record and silently drop whichever fields lost the race (see the
    // enqueueWrite comment in storage.js).
    await Vault.saveFields({
      accounts,
      walletAddresses: [...savedWalletAddresses],
      manualCryptoPositions,
      manualCryptoSales,
      expenses,
      customExpenseCategories,
      hiddenExpenseCategories: [...hiddenExpenseCategories],
      avanzaSnapshot: avanzaSnapshotPayload,
      paypalSnapshot,
      avanzaSession,
      paypalSession
    });
  } catch (err) {
    // Best-effort, same as the old server-sync version — local state still
    // reflects the change either way. Logged (not silent) since a write
    // failure here is now the ONLY copy of the data, unlike before when a
    // localStorage mirror also existed as a fallback.
    console.error('Vault save failed:', err);
  }
}

// Re-fetches each manually-added crypto position's current CoinGecko price
// and updates its stored value (amount × price) to match — so a position
// added weeks ago doesn't keep showing the price it had on entry. Only
// positions added via a CoinGecko link carry a `coinId`; positions typed in
// with a flat value have no live price to compare against, so they're left
// untouched. Best-effort per position: one coin's lookup failing (rate
// limit, delisted, offline) doesn't block the rest from refreshing.
async function refreshManualCryptoPrices() {
  await Promise.all(
    manualCryptoPositions.map(async (pos, idx) => {
      if (!pos.coinId) return;
      try {
        const res = await fetch(`${API_BASE}/api/coin-price/${encodeURIComponent(pos.coinId)}`);
        if (!res.ok) return;
        const { price } = await res.json();
        if (!Number.isFinite(price)) return;
        manualCryptoPositions[idx] = { ...pos, value: pos.amount * price };
      } catch {
        // Leave this position's value as-is — retried on the next login.
      }
    })
  );
}

// Pulls the signed-in user's saved accounts/wallets from the server and
// rebuilds the dashboard from them, replacing whatever was showing before.
// Rebuilds the dashboard from whatever is in the just-unlocked vault,
// replacing whatever was showing before. Direct replacement for the old
// app's GET-profile-then-restore — same shape, just reading local decrypted
// fields instead of a network response.
async function loadProfileAndRestore() {
  const profile = await Vault.loadAllFields();

  const accrued = accrueAccountGrowth(profile.accounts || []);
  accounts = accrued.accounts;
  saveAccounts();
  manualCryptoPositions = profile.manualCryptoPositions || [];
  await refreshManualCryptoPrices();
  saveManualCryptoPositions();
  manualCryptoSales = profile.manualCryptoSales || [];
  saveManualCryptoSales();
  if (manualCryptoPositions.length) cryptoSnapshotUpdatedAt = new Date().toISOString();
  expenses = profile.expenses || [];
  saveExpenses();
  customExpenseCategories = profile.customExpenseCategories || [];
  saveCustomExpenseCategories();
  hiddenExpenseCategories = new Set(profile.hiddenExpenseCategories || []);
  saveHiddenExpenseCategories();
  renderExpenseCategoryOptions(expenseFormType);
  renderExpenses();
  liveAccounts = [];
  savedWalletAddresses.clear();
  Object.keys(cryptoSources).forEach((key) => delete cryptoSources[key]);

  // Every card starts collapsed right after unlocking, regardless of what
  // was expanded in a previous session.
  expandedIds.clear();

  // Restore the last-known Avanza snapshot so the dashboard isn't empty
  // while Avanza itself still requires a fresh login (its session lives
  // only in the relay's memory, not the vault — see server.js). Only
  // applied when nothing live has already populated avanzaSummaries this
  // page load, so a fresher in-memory value is never downgraded.
  if (!avanzaSummaries.size) {
    avanzaSnapshotPayload = profile.avanzaSnapshot || null;
    for (const entry of avanzaSnapshotPayload?.accounts || []) {
      if (entry?.account?.id) avanzaSummaries.set(entry.account.id, entry);
    }
  }
  avanzaSession = profile.avanzaSession || null;
  refreshAvanzaCard();

  if (!paypalSnapshot) paypalSnapshot = profile.paypalSnapshot || null;
  paypalSession = profile.paypalSession || null;
  refreshPaypalCard();

  render();

  // Cached snapshots above already got the dashboard showing something
  // immediately — these attempt a live refresh on top of that using
  // whichever session the vault had, not awaited so a slow/dead relay
  // doesn't hold up the rest of the restore. Each clears its own session on
  // a real auth failure (see checkAvanzaStatus/checkPaypalStatus) rather
  // than leaving a stale one that will just fail again next time.
  if (avanzaSession) checkAvanzaStatus();
  if (paypalSession) checkPaypalStatus();

  for (const address of profile.walletAddresses || []) {
    savedWalletAddresses.add(address);
    try {
      await loadWalletAddress(address, { autoExpand: false, scrollTo: false });
    } catch {
      // Leave the address remembered even if a live reload fails right now
      // (e.g. a chain API hiccup) — it'll be retried next time.
    }
  }

  // Covers the case where a user has manually-added coins but no wallet
  // addresses at all — loadWalletAddress (which normally builds this card)
  // never runs above, so it's built here instead.
  refreshCryptoPortfolioCard();

  // Persists refreshed manual-crypto values now that savedWalletAddresses
  // reflects the full restored set — syncing any earlier (before the loop
  // above repopulates it) would overwrite the vault's walletAddresses with
  // an empty list.
  syncProfileToServer();
}

// Resets every mutable data variable to empty — shared by "create a fresh
// vault" and "lock the vault", both of which need the dashboard to show
// nothing rather than whatever the previous vault/session had in memory.
function resetDashboardState() {
  accounts = [];
  manualCryptoPositions = [];
  manualCryptoSales = [];
  expenses = [];
  liveAccounts = [];
  savedWalletAddresses.clear();
  Object.keys(cryptoSources).forEach((key) => delete cryptoSources[key]);
  saveAccounts();
  saveManualCryptoPositions();
  saveManualCryptoSales();
  saveExpenses();
}

unlockForm.addEventListener('submit', (event) => {
  event.preventDefault();
  authError.textContent = '';
  const passphrase = document.getElementById('unlock-passphrase').value;

  withLoading(async () => {
    try {
      const ok = await Vault.unlockVault(passphrase);
      if (!ok) {
        authError.textContent = 'Incorrect passphrase.';
        return;
      }
      await loadProfileAndRestore();
      showApp();
    } catch (err) {
      authError.textContent = err.message || 'Failed to unlock the vault.';
    }
  });
});

createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  authError.textContent = '';
  const passphrase = document.getElementById('create-passphrase').value;
  const confirmPassphrase = document.getElementById('create-passphrase-confirm').value;
  if (passphrase !== confirmPassphrase) {
    authError.textContent = 'Passphrases do not match.';
    return;
  }

  withLoading(async () => {
    try {
      await Vault.createVault(passphrase);
      // Fresh vault — start from an empty dashboard rather than whatever
      // sample/leftover data happened to be sitting in this browser's
      // plain localStorage (which the vault does not read from).
      resetDashboardState();
      render();
      showApp();
    } catch (err) {
      authError.textContent = err.message || 'Failed to create the vault.';
    }
  });
});

logoutBtn.addEventListener('click', () => {
  Vault.lockVault();
  resetDashboardState();
  render();
  unlockForm.reset();
  setGateView('unlock');
  showGate();
});

// ── Portfolio news ───────────────────────────────────────────────────────────
// One merged, chronological feed for everything currently held: stock/ETF
// headlines are per-holding (resolved by company name → ticker, see
// server.js), crypto headlines are a general crypto feed — not filterable
// by coin. The relay (server.js) sources both keylessly; no client-side API
// key involved. Refetched whenever the held-asset set changes (see the
// scheduleNewsRefresh() calls in
// refreshCryptoPortfolioCard/refreshAvanzaCard above) rather than on every
// render(), which would hammer the API for changes (currency switch, a
// balance edit, ...) that don't affect which assets are actually held.

const newsListEl = document.getElementById('news-list');
const newsRefreshBtn = document.getElementById('news-refresh-btn');
const newsSortWrap = document.getElementById('news-sort-wrap');

let newsItems = [];
let newsExpandedId = null;
let newsFetchFingerprint = '';
let newsLoading = false;

// Persisted like the expense view mode — a page reload keeps showing the
// feed the way it was left instead of resetting to newest-first.
let newsSortOrder = localStorage.getItem(NEWS_SORT_KEY);
if (!['newest', 'oldest', 'asset'].includes(newsSortOrder)) newsSortOrder = 'newest';

// Which specific holding the "By stock/crypto" mode is narrowed to — ''
// means every asset (same as not filtering at all). Deliberately not
// persisted the way newsSortOrder is: which specific coin/stock you last
// drilled into is a much more disposable choice, and held assets can
// change between sessions anyway, so defaulting back to "All" on reload
// is the safer behavior.
let newsAssetFilter = '';

// getHeldStockNames/getHeldCryptoSymbols both build their list by walking
// live positions in encounter order and deduping into a Set — Sets
// preserve insertion order in JS, so the arrays they return already *are*
// "portfolio order" for free. Reused below as the ranking both the
// asset-filter dropdown and the grouped sort order it drives are built
// from, rather than either alphabetizing or leaving date order interleave
// different stocks/coins with each other. Returns a rank(type, symbol,
// name) function closed over one snapshot of that order, so a single
// render pass stays consistent even if holdings change mid-frame.
function newsAssetRankBuilder() {
  const stockOrder = getHeldStockNames();
  const cryptoOrder = getHeldCryptoSymbols();
  return function rank(type, symbol, name) {
    if (type === 'crypto') {
      const i = cryptoOrder.indexOf(symbol);
      return [1, i === -1 ? Infinity : i];
    }
    // 'stock' items, and 'market' items matchHeldName successfully tagged
    // with a held stock's name (see server.js) — both ranked by name here,
    // since that's what's reliably present on both (assetSymbol on a
    // 'market' item may be null if resolution failed even though the name
    // matched).
    const i = name ? stockOrder.indexOf(name) : -1;
    return [0, i === -1 ? Infinity : i];
  };
}

// The set of (type, symbol) pairs actually reachable in the *current*
// newsItems — rebuilt on every render since it depends on what just came
// back from the last fetch, not on holdings directly (an article only
// counts as being "about" an asset if it was actually tagged as such; see
// assetSymbol on each item). Keyed by "type:symbol" so a crypto and a
// stock that happen to share a symbol don't collide into one option.
function getNewsAssetOptions() {
  const rank = newsAssetRankBuilder();
  const map = new Map();
  for (const item of newsItems) {
    if (!item.assetSymbol) continue;
    const key = `${item.assetType}:${item.assetSymbol}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        symbol: item.assetSymbol,
        label: item.assetName ? `${item.assetSymbol} — ${item.assetName}` : item.assetSymbol,
        rank: rank(item.assetType, item.assetSymbol, item.assetName)
      });
    }
  }
  return [...map.values()].sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);
}

// A bespoke dropdown (same reasoning as setupExpenseCategorySelect above:
// not the generic enhanceSelect) — "By stock/crypto" used to open a
// second, separate select next to this one, which read as two unrelated
// menus. It's one row *inside* this menu instead, that expands in place
// (the per-asset choices nested right under it) while the dropdown stays
// open, rather than spawning anything elsewhere.
let newsSortMenuEl = null;
let newsSortLabelEl = null;
let newsSortSubmenuExpanded = false;

// A previously-picked specific asset that's no longer among today's
// options (a stale choice, or the underlying news simply changed) falls
// back to "All" rather than silently filtering to nothing.
function newsSortValueFromState() {
  if (newsSortOrder === 'oldest') return 'oldest';
  if (newsSortOrder === 'asset') return `asset:${newsAssetFilter}`;
  return 'newest';
}

function applyNewsSortValue(value) {
  if (value.startsWith('asset:')) {
    newsSortOrder = 'asset';
    newsAssetFilter = value.slice('asset:'.length);
  } else {
    newsSortOrder = value === 'oldest' ? 'oldest' : 'newest';
    newsAssetFilter = '';
  }
  localStorage.setItem(NEWS_SORT_KEY, newsSortOrder);
  renderNewsPanel();
}

// Rebuilds the menu's contents (called on every renderNewsPanel, same as
// the old select-based version was) — cheap enough, and it's the simplest
// way to keep the label, the selected highlight, and the per-asset
// sub-list all in sync with newsItems/newsSortOrder/newsAssetFilter
// without hand-patching three separate things.
function renderNewsSortMenu() {
  if (!newsSortMenuEl) return;

  const options = getNewsAssetOptions();
  if (newsSortOrder === 'asset' && newsAssetFilter && !options.some((o) => o.key === newsAssetFilter)) {
    newsAssetFilter = '';
  }

  const currentValue = newsSortValueFromState();
  newsSortLabelEl.textContent =
    newsSortOrder === 'asset' && newsAssetFilter
      ? options.find((o) => o.key === newsAssetFilter)?.label || t('news.sortAsset')
      : t(newsSortOrder === 'oldest' ? 'news.sortOldest' : newsSortOrder === 'asset' ? 'news.sortAsset' : 'news.sortNewest');

  const subItemsHtml = options.length
    ? options.map((o) => `<li data-value="asset:${o.key}" class="${currentValue === `asset:${o.key}` ? 'selected' : ''}">${o.label}</li>`).join('')
    : `<li class="news-sort-submenu-empty">${t('news.assetFilterAll')}</li>`;

  newsSortMenuEl.innerHTML = `
    <li data-value="newest" class="${currentValue === 'newest' ? 'selected' : ''}">${t('news.sortNewest')}</li>
    <li data-value="oldest" class="${currentValue === 'oldest' ? 'selected' : ''}">${t('news.sortOldest')}</li>
    <li class="news-sort-expandable${newsSortSubmenuExpanded ? ' expanded' : ''}">
      <div class="news-sort-expandable-row${currentValue === 'asset:' ? ' selected' : ''}" data-value="asset:">
        <span>${t('news.sortAsset')}</span>
        <svg class="news-sort-expandable-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <ul class="news-sort-submenu">${subItemsHtml}</ul>
    </li>
  `;
}

function setupNewsSortSelect() {
  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'custom-select-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `
    <span class="custom-select-label"></span>
    <svg class="dropdown-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
  newsSortLabelEl = btn.querySelector('.custom-select-label');

  const menu = document.createElement('ul');
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');
  newsSortMenuEl = menu;

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const opening = !wrapper.classList.contains('open');
    wrapper.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(opening));
    if (opening) {
      // Reopening with the picker already narrowed to one asset shows
      // that section pre-expanded, so the current pick is visible right
      // away instead of needing an extra click to find it again.
      newsSortSubmenuExpanded = newsSortOrder === 'asset';
      renderNewsSortMenu();
    }
  });

  menu.addEventListener('click', (event) => {
    // A per-asset row inside the expanded sub-list — a final choice, so
    // this closes the dropdown same as picking "Newest"/"Oldest" does.
    const subLi = event.target.closest('.news-sort-submenu li[data-value]');
    if (subLi) {
      applyNewsSortValue(subLi.dataset.value);
      wrapper.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      return;
    }

    // The "By stock/crypto" row itself — expands/collapses its sub-list
    // in place and applies the grouped "All" view immediately, but keeps
    // the dropdown open so a specific asset can still be picked right
    // after without reopening anything.
    const expandRow = event.target.closest('.news-sort-expandable-row');
    if (expandRow) {
      // Deferred, not called synchronously here: renderNewsSortMenu()
      // rebuilds menu's innerHTML, which detaches this very row (the
      // click's own event.target) from the DOM mid-bubble. The document-
      // level "click outside a wrapper closes it" listener further up
      // then sees a *detached* target and wrongly concludes the click
      // landed outside — silently closing the dropdown it was supposed to
      // stay open for. queueMicrotask() is NOT a safe enough defer for
      // this: Chromium runs a microtask checkpoint after every individual
      // event listener callback (not just once after the whole bubble
      // dispatch finishes), so a queued microtask here fires and detaches
      // the row before the bubble even reaches document's listener —
      // confirmed live with real (non-synthetic) clicks via Playwright,
      // where this reliably closed the dropdown even though a plain
      // element.click() in testing didn't reproduce it. setTimeout(...,0)
      // is a real macrotask, guaranteed to run after the current
      // dispatch (and any of its microtasks) has fully finished.
      const value = expandRow.dataset.value;
      setTimeout(() => {
        newsSortSubmenuExpanded = !newsSortSubmenuExpanded;
        applyNewsSortValue(value);
      }, 0);
      return;
    }

    const li = event.target.closest('li[data-value]');
    if (!li) return;
    applyNewsSortValue(li.dataset.value);
    wrapper.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(menu);
  newsSortWrap.appendChild(wrapper);
  renderNewsSortMenu();

  customSelectWrappers.add(wrapper);
  // newsSortWrap (the label+dropdown container, since there's no
  // underlying <select> to key this by anymore) is what
  // PERSISTENT_TRANSLATED_SELECTS calls refreshCustomSelect with on a
  // language switch — same anchor-registration pattern
  // setupExpenseCategorySelect uses for expenseCategoryInput above.
  customSelectSyncFns.set(newsSortWrap, renderNewsSortMenu);
}
setupNewsSortSelect();

// "By stock/crypto" with nothing specific picked in "Show" — every
// article grouped by its own stock/coin (all of one asset's articles
// together, never interleaved with another's), the assets themselves
// ordered to match the portfolio rather than alphabetically or by
// whichever had the newest headline, and every stock kept together as one
// cluster ahead of every coin as the other (see newsAssetRankBuilder).
// Within one asset, still newest-first.
function sortNewsItemsByPortfolioOrder(items) {
  const rank = newsAssetRankBuilder();
  return [...items].sort((a, b) => {
    const [groupA, rankA] = rank(a.assetType, a.assetSymbol, a.assetName);
    const [groupB, rankB] = rank(b.assetType, b.assetSymbol, b.assetName);
    if (groupA !== groupB) return groupA - groupB;
    if (rankA !== rankB) return rankA - rankB;
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });
}

// The actual bug behind "barely any news, just 1-2 companies": pure
// chronological order has no reason to distribute evenly across holdings
// — confirmed live, a portfolio with full 8-article coverage on all 7
// held stocks/coins still put only 2 of them (whichever happened to have
// the most recent headlines) in the first 11 slots under plain
// newest-first, because that's genuinely what "most recent" was. The data
// was always all there; skimming the top of a pure-chronological list
// just doesn't reveal it. This groups by asset the same way "By
// stock/crypto" does (portfolio order, stocks then crypto, newest-first
// *within* one asset — see newsAssetRankBuilder), then round-robins one
// article from each group per pass — so the first N items (N = number of
// distinct held assets) are guaranteed one per asset before any repeats,
// instead of leaving that to however the recency happened to fall.
function interleaveByAsset(items) {
  const rank = newsAssetRankBuilder();
  const groups = new Map();
  const groupRank = new Map();
  for (const item of items) {
    const key = item.assetSymbol ? `${item.assetType}:${item.assetSymbol}` : 'unattributed';
    if (!groups.has(key)) {
      groups.set(key, []);
      groupRank.set(key, item.assetSymbol ? rank(item.assetType, item.assetSymbol, item.assetName) : [2, 0]);
    }
    groups.get(key).push(item);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  }
  const orderedLists = [...groups.keys()]
    .sort((a, b) => {
      const [groupA, rankA] = groupRank.get(a);
      const [groupB, rankB] = groupRank.get(b);
      return groupA - groupB || rankA - rankB;
    })
    .map((key) => groups.get(key));

  const result = [];
  for (let round = 0; result.length < items.length; round++) {
    for (const list of orderedLists) {
      if (round < list.length) result.push(list[round]);
    }
  }
  return result;
}

function sortNewsItems(items) {
  if (newsSortOrder === 'asset' && newsAssetFilter) {
    return items
      .filter((item) => `${item.assetType}:${item.assetSymbol}` === newsAssetFilter)
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  }

  if (newsSortOrder === 'asset') {
    return sortNewsItemsByPortfolioOrder(items);
  }

  if (newsSortOrder === 'oldest') {
    return [...items].sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
  }

  return interleaveByAsset(items);
}

// Every crypto position currently held across wallets + manual entries,
// deduped by symbol — mirrors the filtering buildCryptoPortfolioCardSpec does
// (hidden positions excluded, dust excluded) so news doesn't show up for a
// coin the accounts list itself treats as not really "held" anymore.
function getHeldCryptoSymbols() {
  const rawPositions = [
    ...Object.values(cryptoSources).flatMap((source) => source.positions || []).map(applyCostBasisOverride),
    ...manualCryptoPositions.map(manualPositionToPosition)
  ];
  const symbols = rawPositions
    .filter((p) => !hiddenPositionIds.has(cryptoPositionId(p)) && isMeaningfulValue(p.currentValue))
    .map((p) => p.symbol)
    .filter(Boolean);
  return [...new Set(symbols)];
}

// Every Avanza stock position's display name, deduped, across every
// connected broker account. Funds/ETFs are excluded — Finnhub's free tier
// has no per-holding "what does this fund contain" data (its /etf/holdings
// endpoint 403s without a paid plan, confirmed live), and a fund's own name
// has no "company news" of its own to match against anyway, so attempting it
// only risked a wrong match (an ETF's fund-provider name colliding with an
// unrelated company) — see the Placera-inspired attempt that got reverted.
function getHeldStockNames() {
  const names = [...avanzaSummaries.values()]
    .flatMap((acc) => acc.positions || [])
    .filter((p) => isMeaningfulValue(p.currentValue))
    .map((p) => p.name)
    .filter(Boolean)
    .filter((name) => !/\bETF\b/i.test(name));
  return [...new Set(names)];
}

function newsTimeAgo(iso) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Collapses a burst of near-simultaneous triggers (e.g. five wallets loading
// in parallel each calling refreshCryptoPortfolioCard) into one fetch instead
// of one per trigger. newsRefreshTimer itself is declared way up near the top
// of the file — see the comment there for why.
function scheduleNewsRefresh(delay = 1200) {
  clearTimeout(newsRefreshTimer);
  newsRefreshTimer = setTimeout(fetchPortfolioNews, delay);
}

async function fetchPortfolioNews() {
  const cryptoSymbols = getHeldCryptoSymbols();
  const stockNames = getHeldStockNames();
  const fingerprint = JSON.stringify([cryptoSymbols, stockNames]);
  newsFetchFingerprint = fingerprint;

  if (!cryptoSymbols.length && !stockNames.length) {
    newsItems = [];
    newsLoading = false;
    renderNewsPanel();
    return;
  }

  newsLoading = true;
  renderNewsPanel();

  const cryptoPromise = cryptoSymbols.length
    ? fetch(`${API_BASE}/api/news/crypto?${cryptoSymbols.map((s) => `symbols=${encodeURIComponent(s)}`).join('&')}`)
        .then((r) => r.json())
        .catch(() => ({ items: [] }))
    : Promise.resolve({ items: [] });

  const stockPromise = stockNames.length
    ? fetch(`${API_BASE}/api/news/stocks?${stockNames.map((n) => `names=${encodeURIComponent(n)}`).join('&')}`)
        .then((r) => r.json())
        .catch(() => ({ items: [] }))
    : Promise.resolve({ items: [] });

  // Broad top market news, alongside whatever company-specific matches the
  // call above finds — see /api/news/stocks-general's own comment for why
  // this exists: most held stocks here are non-US listings that /company-
  // news 403s on the free tier regardless of symbol resolution, so this is
  // what keeps the panel from going empty for that kind of portfolio. names
  // are passed here too so a "general" article that's actually about one
  // of your holdings gets tagged with its ticker instead of showing as
  // unattributed market news.
  const marketPromise = stockNames.length
    ? fetch(`${API_BASE}/api/news/stocks-general?hasStocks=1&${stockNames.map((n) => `names=${encodeURIComponent(n)}`).join('&')}`)
        .then((r) => r.json())
        .catch(() => ({ items: [] }))
    : Promise.resolve({ items: [] });

  const [cryptoRes, stockRes, marketRes] = await Promise.all([cryptoPromise, stockPromise, marketPromise]);

  // A slower-to-resolve response for a fingerprint that's since gone stale
  // (holdings changed again while this was in flight) shouldn't clobber
  // whatever a newer request already rendered.
  if (newsFetchFingerprint !== fingerprint) return;

  const merged = [...(cryptoRes.items || []), ...(stockRes.items || []), ...(marketRes.items || [])];
  merged.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  newsItems = merged;
  newsLoading = false;
  renderNewsPanel();
}

function newsItemHtml(item) {
  const expanded = newsExpandedId === item.id;
  // Stock items always carry a resolved ticker; crypto and market items
  // don't (both are general news, not matched to one specific holding —
  // see fetchPortfolioNews) so they fall back to a generic "Crypto"/"Market"
  // pill instead of no badge at all.
  const badge = item.assetSymbol || item.assetName
    || (item.assetType === 'crypto' ? t('news.cryptoBadge') : '')
    || (item.assetType === 'market' ? t('news.marketBadge') : '');
  const thumb = item.imageUrl
    ? `<img class="news-item-thumb" src="${item.imageUrl}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'news-item-thumb news-item-thumb-fallback',textContent:'${(badge || '?').slice(0, 1)}'}))" />`
    : `<span class="news-item-thumb news-item-thumb-fallback">${(badge || '?').slice(0, 1)}</span>`;
  const snippet = item.summary || '';

  return `
    <article class="news-item ${expanded ? 'expanded' : ''}" data-news-id="${item.id}">
      <div class="news-item-header">
        ${thumb}
        <div class="news-item-meta">
          ${badge ? `<span class="news-item-badge">${badge}</span>` : ''}
          <span class="news-item-source">${item.source} &middot; ${newsTimeAgo(item.publishedAt)}</span>
        </div>
      </div>
      <h3 class="news-item-title">${item.title}</h3>
      ${
        expanded
          ? `<p class="news-item-summary">${snippet || t('news.noSummary')}</p><a class="news-item-link" href="${item.url}" target="_blank" rel="noopener">${t('news.readFull')} &#8599;</a>`
          : `<p class="news-item-snippet">${snippet.slice(0, 130)}${snippet.length > 130 ? '…' : ''}</p>`
      }
    </article>
  `;
}

function renderNewsPanel() {
  newsRefreshBtn.disabled = newsLoading;
  renderNewsSortMenu();

  if (newsLoading && !newsItems.length) {
    newsListEl.innerHTML = `<p class="empty-state">${t('news.loading')}</p>`;
    return;
  }

  if (!newsItems.length) {
    newsListEl.innerHTML = `<p class="empty-state">${t('news.empty')}</p>`;
    return;
  }

  newsListEl.innerHTML = sortNewsItems(newsItems).map(newsItemHtml).join('');
}

newsListEl.addEventListener('click', (event) => {
  if (event.target.closest('.news-item-link')) return;
  const item = event.target.closest('.news-item[data-news-id]');
  if (!item) return;
  newsExpandedId = newsExpandedId === item.dataset.newsId ? null : item.dataset.newsId;
  renderNewsPanel();
});

newsRefreshBtn.addEventListener('click', () => fetchPortfolioNews());

// Catches new articles that show up while the dashboard is just left open —
// deliberately modest (not the 1.2s debounce delay above) since this is a
// background poll, not a reaction to something the user just did.
setInterval(() => scheduleNewsRefresh(0), 15 * 60 * 1000);

// ── Language switching ──────────────────────────────────────────────────────
// Applies the current language to every static string in the page, then lets
// the normal re-render pipeline (refreshAllDisplays) regenerate every
// JS-templated string (card titles, stat labels, position rows, ...) since
// those already call t()/tAccountsConnected()/etc. at render time.
const PERSISTENT_TRANSLATED_SELECTS = [
  newAccountType,
  expenseCategoryInput,
  expensePeriodSelect,
  settingsDecimalsSelect,
  settingsSeparatorSelect,
  settingsStakedSelect,
  settingsWeekStartSelect,
  paypalEnvSelect,
  newsSortWrap,
  expenseEntriesSortSelect
];

function applyStaticTranslations() {
  document.documentElement.lang = currentLanguage;

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });

  // <option> text was just retexted above (it matches [data-i18n] too) — the
  // enhanced custom-select UI copied that text into its own DOM at creation
  // time, so it needs an explicit resync per persistent select. Selects
  // rebuilt fresh on every render (inline account-edit type picker, ...)
  // don't need this: they read the current language via t() the next time
  // they're rendered.
  PERSISTENT_TRANSLATED_SELECTS.forEach(refreshCustomSelect);
}

function applyLanguage(lang) {
  currentLanguage = VALID_LANGUAGES.includes(lang) ? lang : 'en';
  localStorage.setItem(LANGUAGE_KEY, currentLanguage);
  applyStaticTranslations();
  updateFlatCurrencyHint();
  updateExpenseCurrencyHint();
  refreshAllDisplays();
}

applyStaticTranslations();

// Boot: an existing vault means this device has used the app before — show
// the Log in screen; no vault means true first run — show Sign up. Either
// way nothing here touches a network.
withLoading(async () => {
  const exists = await Vault.hasExistingVault();
  setGateView(exists ? 'unlock' : 'create');
  showGate();
});
