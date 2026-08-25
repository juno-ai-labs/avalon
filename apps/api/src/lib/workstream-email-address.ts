const textEncoder = new TextEncoder();

export const WORKSTREAM_ADDRESS_GENERATION_VERSION = "v1";

/**
 * The domain every work-stream address minted from now on carries.
 *
 * An address is stored per work stream, not derived on read, so renaming the
 * domain does not move the addresses already issued — and those are printed in
 * mail clients, saved in contacts, and forwarded to by rules nobody here can
 * see. The rename is therefore forward-only: new addresses are minted on
 * `automation.rallywith.ai`, and mail to the old domain keeps routing on the
 * strength of its local part, which is what the routing table is keyed by.
 *
 * A legacy domain leaves this list only when inbound mail to it has stopped.
 */
export const WORKSTREAM_EMAIL_DOMAIN = "automation.rallywith.ai";

/** Domains still accepted inbound, whose addresses are no longer minted. */
export const LEGACY_WORKSTREAM_EMAIL_DOMAINS: readonly string[] = Object.freeze([
  "automation.with-avalon.com",
]);

/** Every domain an inbound work-stream address may arrive on. */
export const ACCEPTED_WORKSTREAM_EMAIL_DOMAINS: readonly string[] = Object.freeze([
  WORKSTREAM_EMAIL_DOMAIN,
  ...LEGACY_WORKSTREAM_EMAIL_DOMAINS,
]);

/**
 * Frozen vocabulary for v1 work-stream email addresses.
 *
 * Array order is part of the address-generation protocol. Do not reorder,
 * remove, or replace entries after v1 addresses have been issued.
 */
export const WORKSTREAM_ADDRESS_ADJECTIVES_V1 = Object.freeze([
  "acoustic",
  "adaptive",
  "aerial",
  "alpine",
  "amber",
  "aquatic",
  "arboreal",
  "arctic",
  "autumnal",
  "axial",
  "azure",
  "boreal",
  "bright",
  "bronze",
  "calibrated",
  "celestial",
  "central",
  "cerulean",
  "circular",
  "classic",
  "clear",
  "coastal",
  "compact",
  "complete",
  "concentric",
  "connected",
  "consistent",
  "constant",
  "continuous",
  "coppery",
  "coral",
  "cosmic",
  "crisp",
  "crystalline",
  "cubic",
  "curved",
  "daylit",
  "diagonal",
  "digital",
  "durable",
  "dynamic",
  "early",
  "efficient",
  "elegant",
  "elliptical",
  "even",
  "evergreen",
  "exact",
  "faceted",
  "flexible",
  "floral",
  "flowing",
  "fluid",
  "forested",
  "frosted",
  "geometric",
  "glassy",
  "glowing",
  "golden",
  "granular",
  "harmonic",
  "helical",
  "horizontal",
  "indexed",
  "integrated",
  "interoperable",
  "iridescent",
  "jade",
  "layered",
  "level",
  "linear",
  "local",
  "luminous",
  "lunar",
  "marine",
  "maritime",
  "measured",
  "methodical",
  "misty",
  "modern",
  "modular",
  "montane",
  "oceanic",
  "orbital",
  "parallel",
  "pearly",
  "planar",
  "polished",
  "portable",
  "precise",
  "prismatic",
  "radial",
  "rainwashed",
  "ready",
  "rectangular",
  "riverside",
  "rounded",
  "russet",
  "scalable",
  "seamless",
  "sequential",
  "silvery",
  "smooth",
  "solar",
  "solid",
  "spacious",
  "spherical",
  "spiral",
  "steady",
  "starlit",
  "streamlined",
  "structured",
  "sunlit",
  "symmetric",
  "systematic",
  "textured",
  "tidal",
  "tidy",
  "unified",
  "useful",
  "verdant",
  "versatile",
  "vertical",
  "vibrant",
  "vivid",
  "windward",
  "wintry",
  "woodland"
] as const);

export const WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1 = Object.freeze([
  "ampere",
  "lovelace",
  "avogadro",
  "babbage",
  "becquerel",
  "bernoulli",
  "bohr",
  "boltzmann",
  "brahe",
  "cavendish",
  "celsius",
  "copernicus",
  "curie",
  "darwin",
  "dirac",
  "doppler",
  "einstein",
  "euler",
  "faraday",
  "fermi",
  "feynman",
  "franklin",
  "galilei",
  "gauss",
  "halley",
  "chandrasekhar",
  "helmholtz",
  "herschel",
  "hertz",
  "hooke",
  "hubble",
  "huygens",
  "joule",
  "kepler",
  "lavoisier",
  "leavitt",
  "leibniz",
  "linnaeus",
  "lorentz",
  "carver",
  "maxwell",
  "meitner",
  "mendel",
  "minkowski",
  "moseley",
  "newton",
  "noether",
  "ohm",
  "oersted",
  "pasteur",
  "pauli",
  "planck",
  "poincare",
  "raman",
  "riemann",
  "rontgen",
  "rutherford",
  "sagan",
  "schrodinger",
  "shannon",
  "tesla",
  "turing",
  "volta",
  "watt",
  "abel",
  "agassiz",
  "agnesi",
  "akasaki",
  "alvarez",
  "anderson",
  "angstrom",
  "anning",
  "arrhenius",
  "aston",
  "avery",
  "baade",
  "backus",
  "baeyer",
  "banach",
  "banting",
  "bardeen",
  "barkla",
  "barton",
  "basov",
  "bayes",
  "beadle",
  "behring",
  "bell",
  "benacerraf",
  "bergius",
  "bethe",
  "bhabha",
  "bhatnagar",
  "birkeland",
  "blackett",
  "bloch",
  "bordet",
  "born",
  "bose",
  "bosch",
  "bothe",
  "bowen",
  "boyle",
  "bragg",
  "braun",
  "brenner",
  "brouwer",
  "buchner",
  "bunsen",
  "burnet",
  "butlerov",
  "cajal",
  "sabatier",
  "cantor",
  "cardano",
  "carrel",
  "cassini",
  "maathai",
  "chadwick",
  "chagas",
  "chain",
  "chapman",
  "chargaff",
  "chatterjee",
  "chebyshev",
  "cherenkov",
  "chern",
  "church",
  "clausius",
  "codd",
  "compton",
  "conway",
  "cori",
  "cormack",
  "coulomb",
  "crick",
  "crookes",
  "cruz",
  "cuvier",
  "dalton",
  "dana",
  "davy",
  "debye",
  "dedekind",
  "delbruck",
  "descartes",
  "dijkstra",
  "diop",
  "dobzhansky",
  "eddington",
  "edison",
  "ehrlich",
  "eijkman",
  "elion",
  "engelbart",
  "erdos",
  "erlang",
  "erlenmeyer",
  "fermat",
  "fischer",
  "fitzroy",
  "florey",
  "flory",
  "foucault",
  "fourier",
  "franck",
  "frege",
  "fresnel",
  "friedmann",
  "fukui",
  "gabor",
  "galois",
  "molina",
  "gamow",
  "geiger",
  "germain",
  "gilbert",
  "glaser",
  "godel",
  "goddard",
  "goeppert",
  "golgi",
  "grassmann",
  "grothendieck",
  "wu",
  "hahn",
  "hale",
  "haldane",
  "hamilton",
  "hamming",
  "harriot",
  "harvey",
  "hausdorff",
  "hawking",
  "haworth",
  "zewail",
  "henry",
  "hess",
  "hevesy",
  "hilbert",
  "hodgkin",
  "hofstadter",
  "holley",
  "holmes",
  "hopkins",
  "houssay",
  "hoyle",
  "humboldt",
  "hutton",
  "ingenhousz",
  "ito",
  "jansky",
  "janssen",
  "jeans",
  "jenner",
  "joliot",
  "mitchell",
  "kapitsa",
  "karrer",
  "katz",
  "kekule",
  "keldysh",
  "kendall",
  "khorana",
  "kilby",
  "kirchhoff",
  "klaproth",
  "klug",
  "koch",
  "kolmogorov",
  "korolev",
  "koshiba",
  "kovalevsky",
  "kramers",
  "milstein",
  "krogh",
  "kuhn",
  "kuiper",
  "kurchatov",
  "lamb",
  "landau",
  "landsteiner",
  "langmuir",
  "laplace",
  "larmor",
  "lawrence",
  "leakey",
  "lebedev",
  "lebesgue",
  "lee",
  "lehmann",
  "lemaitre",
  "leloir",
  "lister",
  "lobachevsky",
  "lyell"
] as const);

export const WORKSTREAM_ADDRESS_ANIMALS_V1 = Object.freeze([
  "aardvark",
  "agouti",
  "albatross",
  "alpaca",
  "anole",
  "antelope",
  "badger",
  "bandicoot",
  "barracuda",
  "basilisk",
  "bass",
  "binturong",
  "bison",
  "bittern",
  "blackbird",
  "bluebird",
  "bluefin",
  "bobcat",
  "bobolink",
  "bonobo",
  "bongo",
  "budgerigar",
  "buffalo",
  "bunting",
  "butterfly",
  "caiman",
  "camel",
  "canary",
  "capybara",
  "caracal",
  "caribou",
  "cassowary",
  "chameleon",
  "chamois",
  "cheetah",
  "chickadee",
  "chinchilla",
  "chipmunk",
  "cicada",
  "civet",
  "coati",
  "cobra",
  "condor",
  "cormorant",
  "coyote",
  "crane",
  "cricket",
  "curlew",
  "cuttlefish",
  "damselfly",
  "deer",
  "dhole",
  "dolphin",
  "dormouse",
  "dove",
  "dragonfly",
  "dugong",
  "eagle",
  "echidna",
  "egret",
  "elephant",
  "eland",
  "elk",
  "emu",
  "falcon",
  "fennec",
  "ferret",
  "finch",
  "firefly",
  "flamingo",
  "flounder",
  "flycatcher",
  "gazelle",
  "gecko",
  "genet",
  "gerbil",
  "gibbon",
  "giraffe",
  "goldfinch",
  "goose",
  "goshawk",
  "grasshopper",
  "grebe",
  "groundhog",
  "grouper",
  "guanaco",
  "guineafowl",
  "guppy",
  "hamster",
  "hare",
  "harrier",
  "hartebeest",
  "hedgehog",
  "heron",
  "hippopotamus",
  "hoopoe",
  "hornbill",
  "hummingbird",
  "hyrax",
  "ibex",
  "ibis",
  "iguana",
  "impala",
  "jackrabbit",
  "jacana",
  "jaguar",
  "jerboa",
  "kangaroo",
  "kingfisher",
  "kinkajou",
  "kiwi",
  "koala",
  "kookaburra",
  "kudu",
  "ladybug",
  "langur",
  "lapwing",
  "lark",
  "lemur",
  "leopard",
  "lion",
  "llama",
  "lobster",
  "lorikeet",
  "lynx",
  "macaw",
  "mallard",
  "manatee",
  "mandrill",
  "manta",
  "marmoset",
  "marmot",
  "marten",
  "meerkat",
  "merganser",
  "mink",
  "minnow",
  "mongoose",
  "moose",
  "moth",
  "mouflon",
  "nautilus",
  "narwhal",
  "newt",
  "nightingale",
  "nilgai",
  "numbat",
  "nuthatch",
  "ocelot",
  "octopus",
  "okapi",
  "opossum",
  "orca",
  "oriole",
  "oryx",
  "osprey",
  "ostrich",
  "otter",
  "owl",
  "panda",
  "pangolin",
  "parakeet",
  "parrot",
  "peccary",
  "pelican",
  "penguin",
  "petrel",
  "pheasant",
  "plover",
  "porcupine",
  "porpoise",
  "potoroo",
  "pronghorn",
  "puffin",
  "puma",
  "quail",
  "quokka",
  "rabbit",
  "raccoon",
  "ray",
  "redpanda",
  "reindeer",
  "rhinoceros",
  "roadrunner",
  "robin",
  "saiga",
  "salamander",
  "salmon",
  "sandpiper",
  "seahorse",
  "seal",
  "serval",
  "shearwater",
  "skink",
  "skylark",
  "sparrow",
  "squid",
  "squirrel",
  "starfish",
  "starling",
  "stingray",
  "stork",
  "sturgeon",
  "swan",
  "swift",
  "tamarin",
  "tanager",
  "tapir",
  "tarpon",
  "tenrec",
  "tern",
  "tiger",
  "tortoise",
  "toucan",
  "treefrog",
  "trout",
  "tuna",
  "turaco",
  "turtle",
  "vicuna",
  "wallaby",
  "warbler",
  "waxwing",
  "whimbrel",
  "wombat",
  "woodpecker",
  "wren",
  "zebra",
  "bluegill",
  "bonito",
  "bream",
  "haddock",
  "hake",
  "pompano",
  "sunfish",
  "trevally",
  "wallaroo",
  "anglerfish",
  "arowana",
  "barnacle",
  "zebrafish",
  "coralfish",
  "darter",
  "dragonet",
  "goby",
  "halibut",
  "lionfish",
  "mackerel",
  "marlin",
  "remora",
  "sailfish",
  "tetra",
  "wrasse",
  "sunbird",
  "terrapin",
  "waxbill"
] as const);

export const WORKSTREAM_ADDRESS_NOUNS_V1 = Object.freeze([
  ...WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1,
  ...WORKSTREAM_ADDRESS_ANIMALS_V1
] as const);

export const WORKSTREAM_ADDRESS_COMBINATION_COUNT_V1 = 1_048_707_072;

export interface AllocateWorkstreamEmailAddressCandidateInput {
  /** A server-only secret with at least 256 bits of UTF-8 or binary key material. */
  secretKey: string | Uint8Array;
  workstreamId: string;
  attempt?: number;
}

function copySecretKey(secretKey: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = typeof secretKey === "string"
    ? textEncoder.encode(secretKey)
    : Uint8Array.from(secretKey);

  if (bytes.byteLength < 32) {
    throw new Error("The work-stream address key must contain at least 32 bytes");
  }

  return bytes;
}

function validateInput(input: AllocateWorkstreamEmailAddressCandidateInput): number {
  if (input.workstreamId.length === 0 || input.workstreamId.includes("\0")) {
    throw new Error("The work-stream ID must be non-empty and must not contain NUL bytes");
  }

  const attempt = input.attempt ?? 0;
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error("The work-stream address attempt must be a non-negative safe integer");
  }

  return attempt;
}

/**
 * Generates one deterministic candidate. The caller must reserve the returned
 * local part atomically and retry with the next attempt after a collision.
 */
export async function allocateWorkstreamEmailAddressCandidate(
  input: AllocateWorkstreamEmailAddressCandidateInput
): Promise<string> {
  const attempt = validateInput(input);
  const key = await crypto.subtle.importKey(
    "raw",
    copySecretKey(input.secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  let block = 0;
  let digest = new Uint8Array(0);
  let cursor = 0;
  let bitBuffer = 0;
  let bufferedBits = 0;

  const nextByte = async (): Promise<number> => {
    if (cursor >= digest.length) {
      const message = textEncoder.encode(
        `${WORKSTREAM_ADDRESS_GENERATION_VERSION}\0${input.workstreamId}\0${attempt}\0${block}`
      );
      digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
      cursor = 0;
      block += 1;
    }

    const value = digest[cursor];
    cursor += 1;
    if (value === undefined) {
      throw new Error("HMAC-SHA256 returned an empty digest");
    }
    return value;
  };

  const nextBits = async (width: 7 | 9): Promise<number> => {
    while (bufferedBits < width) {
      bitBuffer |= (await nextByte()) << bufferedBits;
      bufferedBits += 8;
    }

    const mask = (1 << width) - 1;
    const value = bitBuffer & mask;
    bitBuffer >>>= width;
    bufferedBits -= width;
    return value;
  };

  const firstAdjectiveIndex = await nextBits(7);
  let secondAdjectiveIndex = await nextBits(7);
  while (secondAdjectiveIndex === firstAdjectiveIndex) {
    secondAdjectiveIndex = await nextBits(7);
  }
  let thirdAdjectiveIndex = await nextBits(7);
  while (
    thirdAdjectiveIndex === firstAdjectiveIndex
    || thirdAdjectiveIndex === secondAdjectiveIndex
  ) {
    thirdAdjectiveIndex = await nextBits(7);
  }
  const nounIndex = await nextBits(9);

  const firstAdjective = WORKSTREAM_ADDRESS_ADJECTIVES_V1[firstAdjectiveIndex];
  const secondAdjective = WORKSTREAM_ADDRESS_ADJECTIVES_V1[secondAdjectiveIndex];
  const thirdAdjective = WORKSTREAM_ADDRESS_ADJECTIVES_V1[thirdAdjectiveIndex];
  const noun = WORKSTREAM_ADDRESS_NOUNS_V1[nounIndex];
  if (
    firstAdjective === undefined
    || secondAdjective === undefined
    || thirdAdjective === undefined
    || noun === undefined
  ) {
    throw new Error("The frozen work-stream address vocabulary does not match its index width");
  }

  const localPart = `${firstAdjective}-${secondAdjective}-${thirdAdjective}-${noun}`;
  if (textEncoder.encode(localPart).byteLength > 64) {
    throw new Error("The generated work-stream address exceeds the email local-part limit");
  }

  return localPart;
}
