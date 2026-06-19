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
    id: "business-terse",
    displayName: "Terse business traveler",
    email: "debug.business.terse@omnam.test",
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
    tripFacts: {
      dates: "20 July to 22 July 2026",
      party: "one adult, no children",
      roomComposition: "one quiet room",
      purpose: "business meetings",
      interests: "quiet room, reliable workspace, meeting facilities",
      budget: "company paid, sensible premium",
    },
    openingMessage: "Need a room for a short business stay.",
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
    tripFacts: {
      dates: "5 October to 8 October 2026",
      party: "two adults, no children",
      roomComposition: "one room together",
      purpose: "anniversary weekend",
      interests: "views and walkable local restaurants",
      budget: "keep it moderate, avoid the most expensive option",
    },
    openingMessage: "We want Lake Como, but I do not want to accidentally pick something wildly expensive.",
    stopCondition: "room_plan_proposed",
  },
  {
    id: "accessibility-detail",
    displayName: "Accessibility focused guest",
    email: "debug.accessibility.detail@omnam.test",
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
]

