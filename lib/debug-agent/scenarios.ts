export type ExperienceLevel = "novice" | "guided" | "experienced"
export type GuidanceNeed = "high" | "medium" | "low"
export type DisclosureStyle =
  | "needs_prompting"
  | "answers_only_latest"
  | "partial_answers"
  | "front_loads"
export type FrictionStyle =
  | "confused"
  | "rambling"
  | "direct"
  | "luxury_focused"
  | "price_sensitive"
  | "privacy_cautious"
  | "distracted"
  | "impatient"

export type DebugScenario = {
  id: string
  displayName: string
  email: string
  password: string
  identity: {
    firstName: string
    lastName: string
    phoneNumber: string
    dateOfBirth: string
    nationality: string
    languagePreference: string
  }
  speakingStyle: string
  experienceLevel: ExperienceLevel
  guidanceNeed: GuidanceNeed
  disclosureStyle: DisclosureStyle
  frictionStyle: FrictionStyle
  behaviorRules: string[]
  expectedCheckpointPath: {
    shouldRevealEarly: string[]
    revealOnlyWhenAsked: string[]
    mayResist: string[]
  }
  tripFacts: {
    dates: string
    party: string
    roomComposition: string
    purpose: string
    interests?: string
    budget?: string
    dietary?: string
    accessibility?: string
  }
  openingMessage: string
  stopCondition: "room_plan_proposed" | "booking_opened" | "max_turns"
}

export const DEBUG_SCENARIOS: DebugScenario[] = [
  {
    id: "first-time-blank",
    displayName: "First-time unsure guest",
    email: "debug.first.time.blank@omnam.test",
    password: "Debug!2345",
    identity: {
      firstName: "Elena",
      lastName: "Marquez",
      phoneNumber: "+34 600 000 118",
      dateOfBirth: "1990-03-14",
      nationality: "Spanish",
      languagePreference: "en",
    },
    speakingStyle: "Friendly but uncertain; asks what Ava needs and waits for guidance.",
    experienceLevel: "novice",
    guidanceNeed: "high",
    disclosureStyle: "needs_prompting",
    frictionStyle: "confused",
    behaviorRules: [
      "Do not volunteer booking details until Ava asks a clear question.",
      "If Ava asks a broad question, ask for help narrowing it down.",
      "Once Ava asks a specific question, answer it honestly and briefly.",
    ],
    expectedCheckpointPath: {
      shouldRevealEarly: [],
      revealOnlyWhenAsked: ["dates", "party", "roomComposition", "purpose", "budget"],
      mayResist: [],
    },
    tripFacts: {
      dates: "18 August to 21 August 2026",
      party: "two adults, no children",
      roomComposition: "one room together",
      purpose: "first relaxing Lake Como trip",
      interests: "lake views, calm breakfast, walking around the area",
      budget: "comfortable mid-to-premium, not the highest suite",
    },
    openingMessage: "Hi Ava, I think I want to book something at Lake Como, but I honestly do not know what you need from me.",
    stopCondition: "room_plan_proposed",
  },
  {
    id: "family-rambling",
    displayName: "Rambling family planner",
    email: "debug.family.rambling@omnam.test",
    password: "Debug!2345",
    identity: {
      firstName: "Maya",
      lastName: "Harrington",
      phoneNumber: "+44 7700 900101",
      dateOfBirth: "1984-04-11",
      nationality: "British",
      languagePreference: "en",
    },
    speakingStyle: "Warm, chatty, slightly scattered, gives extra context before answering directly.",
    experienceLevel: "guided",
    guidanceNeed: "medium",
    disclosureStyle: "partial_answers",
    frictionStyle: "rambling",
    behaviorRules: [
      "Give useful details, but mix them with family context.",
      "Sometimes answer only half of a multi-part question.",
      "Let Ava structure the booking details when the conversation gets broad.",
    ],
    expectedCheckpointPath: {
      shouldRevealEarly: ["purpose", "interests"],
      revealOnlyWhenAsked: ["dates", "party", "children ages", "roomComposition", "dietary"],
      mayResist: [],
    },
    tripFacts: {
      dates: "12 August to 16 August 2026",
      party: "two adults and two children aged 8 and 11",
      roomComposition: "connecting rooms if possible, kids nearby but not all in one room",
      purpose: "family summer holiday",
      interests: "lake views, pool, breakfast, relaxed family-friendly spaces",
      budget: "premium is okay, but not the absolute top suite unless it is worth it",
      dietary: "one child is vegetarian",
    },
    openingMessage: "Hi Ava, I am trying to plan something lovely for my family, but I have not really worked out the details yet.",
    stopCondition: "room_plan_proposed",
  },
  {
    id: "business-direct",
    displayName: "Experienced business traveler",
    email: "debug.business.direct@omnam.test",
    password: "Debug!2345",
    identity: {
      firstName: "Daniel",
      lastName: "Chen",
      phoneNumber: "+1 415 555 0188",
      dateOfBirth: "1978-01-22",
      nationality: "American",
      languagePreference: "en",
    },
    speakingStyle: "Short answers, direct, impatient with repeated questions.",
    experienceLevel: "experienced",
    guidanceNeed: "low",
    disclosureStyle: "front_loads",
    frictionStyle: "direct",
    behaviorRules: [
      "Provide dates, party size, and purpose quickly.",
      "If Ava repeats something already provided, sound mildly impatient.",
      "Prefer concise replies over conversational detail.",
    ],
    expectedCheckpointPath: {
      shouldRevealEarly: ["dates", "party", "roomComposition", "purpose"],
      revealOnlyWhenAsked: ["budget", "interests"],
      mayResist: [],
    },
    tripFacts: {
      dates: "20 July to 22 July 2026",
      party: "one adult, no children",
      roomComposition: "one quiet room",
      purpose: "business meetings",
      interests: "quiet room, reliable workspace, meeting facilities",
      budget: "company paid, sensible premium",
    },
    openingMessage: "Need one quiet room, 20 to 22 July 2026, just me, business meetings.",
    stopCondition: "room_plan_proposed",
  },
  {
    id: "honeymoon-luxury",
    displayName: "Luxury honeymoon guest",
    email: "debug.honeymoon.luxury@omnam.test",
    password: "Debug!2345",
    identity: {
      firstName: "Amelia",
      lastName: "Rossi",
      phoneNumber: "+39 320 000 2244",
      dateOfBirth: "1992-09-05",
      nationality: "Italian",
      languagePreference: "en",
    },
    speakingStyle: "Polished, romantic, decisive, likes premium experiences and scenic details.",
    experienceLevel: "guided",
    guidanceNeed: "medium",
    disclosureStyle: "answers_only_latest",
    frictionStyle: "luxury_focused",
    behaviorRules: [
      "Know the mood and quality level you want, but let Ava guide room choice.",
      "Answer Ava's specific questions cleanly.",
      "Do not mention budget unless Ava asks about it.",
    ],
    expectedCheckpointPath: {
      shouldRevealEarly: ["purpose", "interests"],
      revealOnlyWhenAsked: ["dates", "party", "roomComposition", "budget"],
      mayResist: [],
    },
    tripFacts: {
      dates: "3 September to 7 September 2026",
      party: "two adults, no children",
      roomComposition: "one private room or suite together",
      purpose: "honeymoon",
      interests: "lake view, spa, sunset, fine dining",
      budget: "high budget for the right suite",
    },
    openingMessage: "Hello Ava, we are looking for somewhere special for our honeymoon.",
    stopCondition: "room_plan_proposed",
  },
  {
    id: "budget-cautious",
    displayName: "Budget cautious explorer",
    email: "debug.budget.cautious@omnam.test",
    password: "Debug!2345",
    identity: {
      firstName: "Nora",
      lastName: "Klein",
      phoneNumber: "+49 160 000 3344",
      dateOfBirth: "1989-11-18",
      nationality: "German",
      languagePreference: "en",
    },
    speakingStyle: "Curious but price-sensitive; asks whether recommendations are worth the cost.",
    experienceLevel: "guided",
    guidanceNeed: "medium",
    disclosureStyle: "answers_only_latest",
    frictionStyle: "price_sensitive",
    behaviorRules: [
      "Avoid naming an exact budget until Ava asks gently.",
      "Ask whether premium recommendations are really worth it.",
      "Answer booking facts when asked, but keep price in mind.",
    ],
    expectedCheckpointPath: {
      shouldRevealEarly: ["purpose"],
      revealOnlyWhenAsked: ["dates", "party", "roomComposition", "budget", "interests"],
      mayResist: ["budget"],
    },
    tripFacts: {
      dates: "5 October to 8 October 2026",
      party: "two adults, no children",
      roomComposition: "one room together",
      purpose: "anniversary weekend",
      interests: "views and walkable local restaurants",
      budget: "keep it moderate, avoid the most expensive option",
    },
    openingMessage: "We want Lake Como for an anniversary, but I do not want to accidentally pick something wildly expensive.",
    stopCondition: "room_plan_proposed",
  },
  {
    id: "accessibility-cautious",
    displayName: "Accessibility focused guest",
    email: "debug.accessibility.cautious@omnam.test",
    password: "Debug!2345",
    identity: {
      firstName: "Priya",
      lastName: "Shah",
      phoneNumber: "+44 7700 900222",
      dateOfBirth: "1975-06-29",
      nationality: "British",
      languagePreference: "en",
    },
    speakingStyle: "Detail-oriented and careful; wants reassurance before moving forward.",
    experienceLevel: "guided",
    guidanceNeed: "medium",
    disclosureStyle: "answers_only_latest",
    frictionStyle: "privacy_cautious",
    behaviorRules: [
      "Share accessibility details once Ava explains why they matter.",
      "Ask for reassurance if Ava moves too quickly.",
      "Give precise answers after trust is established.",
    ],
    expectedCheckpointPath: {
      shouldRevealEarly: ["purpose", "accessibility"],
      revealOnlyWhenAsked: ["dates", "party", "roomComposition"],
      mayResist: ["accessibility"],
    },
    tripFacts: {
      dates: "14 November to 18 November 2026",
      party: "three adults, no children",
      roomComposition: "two rooms, one for my parents and one for me",
      purpose: "birthday celebration for my mother",
      interests: "easy access, lake views, calm spaces",
      accessibility: "step-free access and minimal walking for one parent",
    },
    openingMessage: "I need help planning a stay for my mother's birthday, but accessibility matters a lot.",
    stopCondition: "room_plan_proposed",
  },
  {
    id: "distracted-parent",
    displayName: "Distracted parent",
    email: "debug.distracted.parent@omnam.test",
    password: "Debug!2345",
    identity: {
      firstName: "Sam",
      lastName: "Okafor",
      phoneNumber: "+44 7700 900303",
      dateOfBirth: "1986-12-02",
      nationality: "British",
      languagePreference: "en",
    },
    speakingStyle: "Friendly but interrupted; answers in fragments and sometimes forgets part of the question.",
    experienceLevel: "novice",
    guidanceNeed: "high",
    disclosureStyle: "partial_answers",
    frictionStyle: "distracted",
    behaviorRules: [
      "Sometimes answer only one part of Ava's question.",
      "Occasionally mention being interrupted or checking with a partner.",
      "Let Ava pull the missing details back into focus.",
    ],
    expectedCheckpointPath: {
      shouldRevealEarly: [],
      revealOnlyWhenAsked: ["dates", "party", "children ages", "roomComposition", "purpose", "dietary"],
      mayResist: [],
    },
    tripFacts: {
      dates: "24 August to 28 August 2026",
      party: "two adults and one child aged 5",
      roomComposition: "one larger room or suite together",
      purpose: "late summer family break",
      interests: "pool, breakfast, easy room setup",
      dietary: "nut allergy for the child",
    },
    openingMessage: "Hi, sorry, I am half multitasking. We need a family stay, I think.",
    stopCondition: "room_plan_proposed",
  },
  {
    id: "impatient-returning",
    displayName: "Impatient decisive guest",
    email: "debug.impatient.returning@omnam.test",
    password: "Debug!2345",
    identity: {
      firstName: "Victor",
      lastName: "Laurent",
      phoneNumber: "+33 6 00 00 45 91",
      dateOfBirth: "1981-07-07",
      nationality: "French",
      languagePreference: "en",
    },
    speakingStyle: "Confident, terse, and expects Ava to keep up.",
    experienceLevel: "experienced",
    guidanceNeed: "low",
    disclosureStyle: "front_loads",
    frictionStyle: "impatient",
    behaviorRules: [
      "Front-load the main booking facts.",
      "Ask Ava to move on if she repeats known details.",
      "Do not provide optional preferences unless Ava asks.",
    ],
    expectedCheckpointPath: {
      shouldRevealEarly: ["dates", "party", "roomComposition", "purpose"],
      revealOnlyWhenAsked: ["interests", "budget"],
      mayResist: [],
    },
    tripFacts: {
      dates: "10 December to 13 December 2026",
      party: "four adults, no children",
      roomComposition: "two rooms, two adults per room",
      purpose: "friends weekend",
      interests: "dining, lake views, evening atmosphere",
      budget: "premium is fine if the rooms fit well",
    },
    openingMessage: "Four adults, 10 to 13 December, two rooms, friends weekend. Show me the best fit.",
    stopCondition: "room_plan_proposed",
  },
  {
    id: "solo-wellness-unsure",
    displayName: "Solo wellness novice",
    email: "debug.solo.wellness.unsure@omnam.test",
    password: "Debug!2345",
    identity: {
      firstName: "Grace",
      lastName: "Turner",
      phoneNumber: "+44 7700 900404",
      dateOfBirth: "1995-05-19",
      nationality: "British",
      languagePreference: "en",
    },
    speakingStyle: "Soft-spoken, a little unsure, interested in wellness but not confident about hotel categories.",
    experienceLevel: "novice",
    guidanceNeed: "high",
    disclosureStyle: "needs_prompting",
    frictionStyle: "confused",
    behaviorRules: [
      "Do not know which details matter for a hotel booking.",
      "Answer specific Ava questions, but ask for examples if the question is too broad.",
      "Mention wellness preferences only when Ava asks what kind of stay you want.",
    ],
    expectedCheckpointPath: {
      shouldRevealEarly: [],
      revealOnlyWhenAsked: ["dates", "party", "roomComposition", "purpose", "interests", "budget"],
      mayResist: [],
    },
    tripFacts: {
      dates: "2 February to 5 February 2027",
      party: "one adult, no children",
      roomComposition: "one quiet room",
      purpose: "solo wellness reset",
      interests: "spa, calm lake view, quiet breakfast",
      budget: "flexible but not extravagant",
    },
    openingMessage: "Hi Ava, I want a quiet few days away but I am not sure how to choose the right room.",
    stopCondition: "room_plan_proposed",
  },
  {
    id: "multigen-organized",
    displayName: "Organized multi-generation planner",
    email: "debug.multigen.organized@omnam.test",
    password: "Debug!2345",
    identity: {
      firstName: "Omar",
      lastName: "Nasser",
      phoneNumber: "+971 50 000 7721",
      dateOfBirth: "1980-10-23",
      nationality: "Emirati",
      languagePreference: "en",
    },
    speakingStyle: "Organized, polite, and precise; has the main facts ready but expects Ava to handle fit and flow.",
    experienceLevel: "experienced",
    guidanceNeed: "low",
    disclosureStyle: "front_loads",
    frictionStyle: "direct",
    behaviorRules: [
      "Provide the core booking facts early.",
      "Answer follow-up questions precisely.",
      "Expect Ava to recommend a sensible configuration without unnecessary repetition.",
    ],
    expectedCheckpointPath: {
      shouldRevealEarly: ["dates", "party", "children ages", "roomComposition", "purpose"],
      revealOnlyWhenAsked: ["interests", "accessibility", "budget"],
      mayResist: [],
    },
    tripFacts: {
      dates: "6 April to 10 April 2027",
      party: "five adults and two children aged 6 and 9",
      roomComposition: "three rooms, with grandparents in one quiet room and the children near their parents",
      purpose: "multi-generation spring holiday",
      interests: "lake views, calm rooms, family-friendly breakfast",
      accessibility: "one grandparent prefers minimal stairs",
      budget: "premium family configuration is acceptable",
    },
    openingMessage: "We need 6 to 10 April, five adults and two children aged 6 and 9, ideally three rooms for a family holiday.",
    stopCondition: "room_plan_proposed",
  },
]
