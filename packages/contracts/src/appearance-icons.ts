/**
 * The icon catalog every chosen appearance picks from: a Channel, a Breakout, a
 * Space and a Sidekick alike.
 *
 * Grouped into sections because the picker shows them that way, with a tab per
 * section along its top, and because a catalog this size is scanned by group
 * before it is scanned by glyph. The order of sections, and of keys within one,
 * is the order a person and a model both see.
 *
 * Every key is a Lucide icon name. The keys are stored values: renaming or
 * removing one needs every stored copy accounted for, which is what
 * {@link RETIRED_APPEARANCE_ICON_KEYS} is for.
 */
export const APPEARANCE_ICON_SECTIONS = [
  {
    id: "planning",
    label: "Planning",
    keys: [
      "target", "flag", "goal", "calendar", "calendar-days", "calendar-check", "clock",
      "alarm-clock", "hourglass", "timer", "list-todo", "list-check", "list-checks",
      "clipboard-list", "clipboard-check", "kanban", "milestone", "chart-gantt", "briefcase",
      "inbox", "archive", "square-check-big", "circle-dot",
    ],
  },
  {
    id: "docs",
    label: "Docs & writing",
    keys: [
      "file-text", "files", "file", "file-pen", "folder", "folder-open", "notebook",
      "notebook-pen", "sticky-note", "notepad-text", "pencil", "pen-line", "highlighter",
      "signature", "book-open", "book-marked", "bookmark", "quote", "text-quote",
      "newspaper", "scroll", "paperclip", "printer",
    ],
  },
  {
    id: "learning",
    label: "Learning",
    keys: [
      "lightbulb", "brain", "graduation-cap", "school", "library", "book", "book-text",
      "award", "medal", "search", "microscope", "telescope", "flask-conical", "test-tube",
      "atom", "dna", "ruler", "calculator", "sigma", "languages", "glasses", "presentation",
      "shapes",
    ],
  },
  {
    id: "people",
    label: "People",
    keys: [
      "user", "user-round", "users", "users-round", "user-plus", "user-check", "user-search",
      "handshake", "heart-handshake", "contact-round", "id-card", "baby", "person-standing",
      "accessibility", "hand", "hand-heart", "thumbs-up", "smile", "laugh", "crown",
      "venetian-mask", "cake", "hand-metal",
    ],
  },
  {
    id: "talk",
    label: "Talk",
    keys: [
      "message-square", "message-circle", "messages-square", "speech", "mail", "mail-open",
      "send", "phone", "phone-call", "megaphone", "mic", "video", "webcam", "at-sign", "bell",
      "bell-ring", "radio", "podcast", "rss", "reply", "share-2", "link", "ear",
    ],
  },
  {
    id: "data",
    label: "Data & money",
    keys: [
      "chart-column", "chart-line", "chart-pie", "chart-bar", "chart-area", "chart-candlestick",
      "trending-up", "trending-down", "activity", "gauge", "database", "table", "sheet",
      "coins", "banknote", "credit-card", "wallet", "receipt", "piggy-bank", "dollar-sign",
      "hand-coins", "percent", "scale",
    ],
  },
  {
    id: "build",
    label: "Build & tech",
    keys: [
      "code", "braces", "terminal", "bug", "git-branch", "git-pull-request", "git-merge",
      "server", "cloud-upload", "cpu", "bot", "webhook", "wrench", "hammer", "settings",
      "puzzle", "laptop", "smartphone", "monitor", "key", "lock", "shield-check", "rocket",
    ],
  },
  {
    id: "places",
    label: "Places & travel",
    keys: [
      "house", "building", "building-2", "store", "landmark", "factory", "hospital", "church",
      "castle", "globe", "earth", "map-pin", "map", "compass", "navigation", "plane", "car",
      "bus", "train-front", "ship", "bike", "tent", "luggage",
    ],
  },
  {
    id: "nature",
    label: "Nature",
    keys: [
      "sun", "moon", "star", "sparkles", "cloud", "cloud-rain", "cloud-lightning", "snowflake",
      "rainbow", "flame", "droplet", "waves", "mountain-snow", "leaf", "sprout", "tree-pine",
      "tree-palm", "flower", "paw-print", "cat", "dog", "bird", "fish",
    ],
  },
  {
    id: "life",
    label: "Life & culture",
    keys: [
      "palette", "brush", "camera", "image", "film", "clapperboard", "music", "headphones",
      "guitar", "tv", "coffee", "utensils", "pizza", "wine", "gift", "trophy", "heart",
      "dumbbell", "heart-pulse", "shopping-bag", "shopping-cart", "shirt", "zap",
    ],
  },
  {
    id: "fun",
    label: "Fun",
    keys: [
      "party-popper", "ghost", "gamepad-2", "dices", "joystick", "skull", "wand-sparkles",
      "drama", "ferris-wheel", "balloon", "tickets", "popcorn", "ice-cream-cone", "lollipop",
      "cookie", "donut", "origami", "turtle", "rabbit", "squirrel", "piano", "drum", "disc-3",
    ],
  },
] as const;

export type AppearanceIconSection = (typeof APPEARANCE_ICON_SECTIONS)[number];
export type AppearanceIconSectionId = AppearanceIconSection["id"];

/** A key a person or a model may choose today. */
export type PickableAppearanceIconKey = AppearanceIconSection["keys"][number];

/** Every pickable key, section by section, in the order both audiences see. */
export const PICKABLE_APPEARANCE_ICON_KEYS = APPEARANCE_ICON_SECTIONS.flatMap(
  (section) => section.keys,
) as readonly PickableAppearanceIconKey[] as [PickableAppearanceIconKey, ...PickableAppearanceIconKey[]];

/**
 * Keys an earlier catalog offered and this one does not.
 *
 * Off the menu, never out of the vocabulary. An appearance schema parses on
 * every read, so a key somebody already holds has to keep parsing and keep
 * rendering; dropping it here would turn a catalog edit into a failed read for
 * whoever chose it. The same split the colours make between the ring and
 * `PROJECT_COLOR_KEYS_STORABLE`.
 */
export const RETIRED_APPEARANCE_ICON_KEYS = [
  "aperture", "boxes", "circuit-board", "component", "orbit", "spline", "workflow",
  "chart-no-axes-combined", "pen-tool", "package", "globe-2",
] as const;

/** What a stored icon may hold: the menu plus every key it has ever offered. */
export const STORABLE_APPEARANCE_ICON_KEYS = [
  ...PICKABLE_APPEARANCE_ICON_KEYS,
  ...RETIRED_APPEARANCE_ICON_KEYS,
] as [PickableAppearanceIconKey | (typeof RETIRED_APPEARANCE_ICON_KEYS)[number], ...(PickableAppearanceIconKey | (typeof RETIRED_APPEARANCE_ICON_KEYS)[number])[]];

export type StorableAppearanceIconKey = (typeof STORABLE_APPEARANCE_ICON_KEYS)[number];

/**
 * The marks an appearance nobody chose is drawn with, indexed by a hash of the
 * id. The order is load-bearing: reordering or extending this list changes the
 * default mark of every work stream that never had one chosen.
 */
export const GENERATED_APPEARANCE_ICON_KEYS = [
  "aperture", "atom", "boxes", "circle-dot", "circuit-board", "component",
  "dices", "orbit", "sparkles", "spline", "wand-sparkles", "workflow",
] as const satisfies readonly StorableAppearanceIconKey[];

/**
 * What each pickable icon draws, for the model that chooses one.
 *
 * The naming pass and the Sidekick setup chat both read these, so they describe
 * the drawing and nothing else: say what a reader would call the thing, then
 * the one detail that tells it from its neighbours, and stop. No line says what
 * an icon is for. Matching belongs to the model, which has the request; a usage
 * note here narrows an icon to the cases its writer thought of.
 *
 * Naming what it depicts is part of describing the drawing, not a usage note.
 * An earlier draft described `coins` as two overlapping discs and `list-checks`
 * as ticked lines above an unticked one, and the model, left to work out what
 * the shapes were, put a checklist on an invoice reconciliation.
 *
 * Kept short on purpose: every line ships in every naming prompt, and a picture
 * a person can take in at a glance needs a phrase, not a paragraph. Plain words
 * only, per `docs/writing-prompts.md`.
 *
 * A `Record` over the pickable keys, so a key added without a description fails
 * to compile.
 */
export const APPEARANCE_ICON_DESCRIPTIONS: Record<PickableAppearanceIconKey, string> = {
  // Planning
  target: "A bullseye: three nested rings around a centre dot.",
  flag: "A flag on a pole, its banner waving.",
  goal: "A flag planted in the centre of a target.",
  calendar: "A blank calendar page with two binder rings.",
  "calendar-days": "A calendar page with a grid of day dots.",
  "calendar-check": "A calendar page with a tick on it.",
  clock: "A round clock face with two hands.",
  "alarm-clock": "An alarm clock with two bells and little legs.",
  hourglass: "An hourglass: two glass bulbs joined at a narrow waist.",
  timer: "A stopwatch with a button on top and one hand.",
  "list-todo": "A to-do list: a ticked box and an empty box, each beside a line.",
  "list-check": "Three lines of a list with a tick after the last.",
  "list-checks": "A checklist: two ticked lines above a third.",
  "clipboard-list": "A clipboard holding a bulleted list.",
  "clipboard-check": "A clipboard with a large tick on its page.",
  kanban: "A kanban board: three vertical columns of different lengths.",
  milestone: "A signpost on a pole, its sign pointing one way.",
  "chart-gantt": "A Gantt chart: staggered horizontal bars on an axis.",
  briefcase: "A briefcase with a handle on top.",
  inbox: "An inbox tray with a notch in its front.",
  archive: "An archive box with a lid and a handle slot.",
  "square-check-big": "A square box with a large tick through it.",
  "circle-dot": "A dot in the centre of an empty ring.",

  // Docs & writing
  "file-text": "A page with a folded corner and lines of text.",
  files: "Two pages stacked, one behind the other.",
  file: "A blank page with a folded corner.",
  "file-pen": "A page with a pen writing across it.",
  folder: "A closed file folder with a tab.",
  "folder-open": "An open file folder, its front flap tipped forward.",
  notebook: "A spiral-bound notebook seen from the front.",
  "notebook-pen": "A notebook with a pen resting across its corner.",
  "sticky-note": "A square sticky note with its corner curled.",
  "notepad-text": "A notepad with rings at the top and lines of text.",
  pencil: "A pencil on a diagonal, point down.",
  "pen-line": "A pen on a diagonal above a line it has drawn.",
  highlighter: "A highlighter marker with a chisel tip.",
  signature: "A pen nib above a looping signature on a line.",
  "book-open": "An open book seen from above, two facing pages.",
  "book-marked": "A closed book with a ribbon bookmark hanging out.",
  bookmark: "A ribbon bookmark with a notched end.",
  quote: "A pair of large quotation marks.",
  "text-quote": "Lines of text with a bar beside them, set off as a quote.",
  newspaper: "A folded newspaper with a headline and columns.",
  scroll: "A paper scroll, curled at both ends.",
  paperclip: "A bent-wire paperclip on a diagonal.",
  printer: "A printer with a sheet coming out of it.",

  // Learning
  lightbulb: "A light bulb with a screw base.",
  brain: "A brain seen from the side, its folds drawn as curves.",
  "graduation-cap": "A graduation cap with a tassel.",
  school: "A school building with a peaked centre and two wings.",
  library: "Books standing on a shelf, one leaning.",
  book: "A closed book, cover facing out.",
  "book-text": "A closed book with lines of text on its cover.",
  award: "A rosette: a round medal with two ribbon tails.",
  medal: "A medal hanging from a V-shaped ribbon.",
  search: "A magnifying glass.",
  microscope: "A microscope with its eyepiece angled up.",
  telescope: "A telescope on a tripod, aimed at the sky.",
  "flask-conical": "A cone-shaped lab flask with liquid in it.",
  "test-tube": "A single test tube standing upright.",
  atom: "An atom: two crossing electron orbits around a nucleus.",
  dna: "A DNA double helix: two strands twisting with rungs between.",
  ruler: "A ruler on a diagonal with tick marks.",
  calculator: "A calculator with a display and a grid of keys.",
  sigma: "The Greek letter sigma, a summation sign.",
  languages: "Two letters from different scripts, a Latin A beside an Asian character.",
  glasses: "A pair of round eyeglasses.",
  presentation: "A presentation board on a stand.",
  shapes: "A triangle, a square and a circle grouped together.",

  // People
  user: "One person, head and shoulders.",
  "user-round": "One person, head and rounded shoulders.",
  users: "Two people, one in front of the other.",
  "users-round": "Two people with rounded shoulders, side by side.",
  "user-plus": "One person with a plus sign beside them.",
  "user-check": "One person with a tick beside them.",
  "user-search": "One person with a magnifying glass beside them.",
  handshake: "Two hands clasped in a handshake.",
  "heart-handshake": "A heart with two hands clasped inside it.",
  "contact-round": "A contact card with a person's portrait on it.",
  "id-card": "An ID card with a photo and lines of text.",
  baby: "A baby's face with a curl of hair.",
  "person-standing": "A stick figure standing with arms out.",
  accessibility: "The universal access figure: a person with arms and legs spread.",
  hand: "An open hand, palm out.",
  "hand-heart": "An open hand holding a heart.",
  "thumbs-up": "A hand giving a thumbs-up.",
  smile: "A round smiling face.",
  laugh: "A round face laughing with its mouth open.",
  crown: "A king's crown with three points.",
  "venetian-mask": "A masquerade mask covering the eyes.",
  cake: "A layered birthday cake with candles.",
  "hand-metal": "A hand making the rock-on sign.",

  // Talk
  "message-square": "A square speech bubble.",
  "message-circle": "A round speech bubble.",
  "messages-square": "Two overlapping square speech bubbles.",
  speech: "A head in profile with sound waves from its mouth.",
  mail: "A sealed envelope.",
  "mail-open": "An open envelope, its flap up.",
  send: "A paper plane in flight.",
  phone: "A phone handset.",
  "phone-call": "A phone handset with sound waves beside it.",
  megaphone: "A megaphone, its cone widening outward.",
  mic: "A studio microphone on a stand.",
  video: "A video camera seen from the side.",
  webcam: "A webcam: a round lens on a small stand.",
  "at-sign": "The at sign, @.",
  bell: "A bell.",
  "bell-ring": "A bell swinging, with ringing lines beside it.",
  radio: "A broadcast mast sending out waves on both sides.",
  podcast: "A microphone inside rings of broadcast waves.",
  rss: "A feed symbol: a dot with two widening arcs.",
  reply: "An arrow curving back to the left.",
  "share-2": "Three dots joined by two lines, a share symbol.",
  link: "Two chain links joined.",
  ear: "A human ear in profile.",

  // Data & money
  "chart-column": "A column chart: vertical bars on an axis.",
  "chart-line": "A line chart rising across two axes.",
  "chart-pie": "A pie chart with one slice pulled out.",
  "chart-bar": "A bar chart: horizontal bars of different lengths.",
  "chart-area": "An area chart: a filled line over an axis.",
  "chart-candlestick": "A candlestick chart: bars with wicks above and below.",
  "trending-up": "A zigzag line ending in an arrow pointing up.",
  "trending-down": "A zigzag line ending in an arrow pointing down.",
  activity: "A heartbeat line: flat, then a sharp spike.",
  gauge: "A dial gauge with a needle.",
  database: "A database: a stack of three discs.",
  table: "A table grid of rows and columns.",
  sheet: "A spreadsheet grid with a header row.",
  coins: "Two coins, one behind the other.",
  banknote: "A banknote with a circle in its centre.",
  "credit-card": "A credit card with a stripe across it.",
  wallet: "A wallet with a clasp.",
  receipt: "A paper receipt with a torn bottom edge.",
  "piggy-bank": "A piggy bank seen from the side.",
  "dollar-sign": "The dollar sign, $.",
  "hand-coins": "An open hand with coins above it.",
  percent: "The percent sign, %.",
  scale: "A balance scale with two pans.",

  // Build & tech
  code: "Two angle brackets, < and >.",
  braces: "A pair of curly braces, { and }.",
  terminal: "A command prompt: an arrow and a cursor line.",
  bug: "An insect with legs and antennae.",
  "git-branch": "Two branch lines splitting from a main line, with dots at the ends.",
  "git-pull-request": "Two lines with dots, an arrow carrying one into the other.",
  "git-merge": "Two branch lines joining back into one.",
  server: "A server rack: two stacked units with lights.",
  "cloud-upload": "A cloud with an arrow pointing up into it.",
  cpu: "A computer chip with pins on all four sides.",
  bot: "A robot head with an antenna.",
  webhook: "Three hooked lines joined in a triangle.",
  wrench: "A wrench on a diagonal.",
  hammer: "A hammer on a diagonal.",
  settings: "A gear cog.",
  puzzle: "A jigsaw puzzle piece.",
  laptop: "An open laptop.",
  smartphone: "A smartphone held upright.",
  monitor: "A desktop monitor on a stand.",
  key: "A key on a diagonal.",
  lock: "A closed padlock.",
  "shield-check": "A shield with a tick on it.",
  rocket: "A rocket lifting off on a diagonal.",

  // Places & travel
  house: "A house with a pitched roof and a door.",
  building: "A tall office building with rows of windows.",
  "building-2": "Two office buildings side by side, one taller.",
  store: "A shop front with a striped awning.",
  landmark: "A classical building with columns and a pediment.",
  factory: "A factory with a sawtooth roof and a chimney.",
  hospital: "A hospital building with a cross on its front.",
  church: "A church with a steeple and a cross.",
  castle: "A castle with battlements and a gate.",
  globe: "A globe with lines of latitude and longitude.",
  earth: "The Earth with continents drawn on it.",
  "map-pin": "A map pin: a teardrop marker with a hole.",
  map: "A folded paper map.",
  compass: "A compass with its needle.",
  navigation: "A navigation arrow pointing up and to the right.",
  plane: "An aeroplane in flight, seen from above.",
  car: "A car seen from the side.",
  bus: "A bus seen from the front.",
  "train-front": "A train seen from the front.",
  ship: "A ship on waves.",
  bike: "A bicycle seen from the side.",
  tent: "A camping tent.",
  luggage: "A suitcase standing upright on wheels.",

  // Nature
  sun: "A sun: a circle with short rays.",
  moon: "A crescent moon.",
  star: "A five-pointed star.",
  sparkles: "Three four-pointed sparkles, one large and two small.",
  cloud: "A cloud.",
  "cloud-rain": "A cloud with rain falling from it.",
  "cloud-lightning": "A cloud with a lightning bolt beneath it.",
  snowflake: "A six-armed snowflake.",
  rainbow: "A rainbow: three nested arcs.",
  flame: "A flame.",
  droplet: "A single water drop.",
  waves: "Three wavy lines of water.",
  "mountain-snow": "A mountain with a snowcap.",
  leaf: "A single leaf with a stem.",
  sprout: "A seedling sprouting two leaves.",
  "tree-pine": "A pine tree.",
  "tree-palm": "A palm tree.",
  flower: "A flower head with round petals.",
  "paw-print": "An animal's paw print.",
  cat: "A cat's face with pointed ears and whiskers.",
  dog: "A dog's face with floppy ears.",
  bird: "A bird in profile.",
  fish: "A fish swimming sideways.",

  // Life & culture
  palette: "An artist's paint palette with wells of paint.",
  brush: "A paintbrush on a diagonal.",
  camera: "A camera with a round lens.",
  image: "A framed picture of a hill and a sun.",
  film: "A strip of film with sprocket holes.",
  clapperboard: "A film clapperboard, its top bar open.",
  music: "Two musical notes joined by a beam.",
  headphones: "A pair of over-ear headphones.",
  guitar: "An acoustic guitar on a diagonal.",
  tv: "A television with antennae.",
  coffee: "A coffee mug with steam rising.",
  utensils: "A fork and knife side by side.",
  pizza: "A slice of pizza.",
  wine: "A wine glass.",
  gift: "A wrapped gift box with a bow.",
  trophy: "A trophy cup with two handles.",
  heart: "A heart.",
  dumbbell: "A dumbbell on a diagonal.",
  "heart-pulse": "A heart with a heartbeat line through it.",
  "shopping-bag": "A shopping bag with handles.",
  "shopping-cart": "A shopping cart.",
  shirt: "A T-shirt.",
  zap: "A lightning bolt.",

  // Fun
  "party-popper": "A party popper bursting with confetti.",
  ghost: "A cartoon ghost with a wavy hem.",
  "gamepad-2": "A video game controller.",
  dices: "Two dice, one behind the other.",
  joystick: "An arcade joystick on a base.",
  skull: "A skull seen from the front.",
  "wand-sparkles": "A magic wand throwing off sparkles.",
  drama: "The comedy and tragedy theatre masks.",
  "ferris-wheel": "A Ferris wheel.",
  balloon: "A single balloon on a string.",
  tickets: "Two overlapping admission tickets.",
  popcorn: "A striped popcorn box, overflowing.",
  "ice-cream-cone": "An ice cream cone with one scoop.",
  lollipop: "A spiral lollipop on a stick.",
  cookie: "A round cookie with chips.",
  donut: "A donut with a hole and sprinkles.",
  origami: "An origami paper bird.",
  turtle: "A turtle with a patterned shell.",
  rabbit: "A rabbit with long ears.",
  squirrel: "A squirrel with a bushy tail.",
  piano: "A grand piano seen from the side.",
  drum: "A drum with two crossed sticks.",
  "disc-3": "A vinyl record.",
};
