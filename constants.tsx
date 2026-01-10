
import { Tenant, User, UserRole } from './types';

export const LESSON_RATE = 7.50;
export const MAX_REPLACEMENTS = 5;

// Mock de agendamentos fixos - ZERADO para início limpo
export const MOCK_BOOKINGS: Record<string, { student: string; module: string }> = {};

export const MOCK_TENANTS: Record<string, Tenant> = {
  'royal-british': {
    id: 'royal-british',
    name: 'Royal British School',
    domain: 'royal.school.com',
    branding: {
      primaryColor: '#002366',
      secondaryColor: '#D32F2F',
      logoUrl: 'https://cdn-icons-png.flaticon.com/512/3601/3601639.png',
      faviconUrl: 'https://cdn-icons-png.flaticon.com/512/3601/3601639.png',
    },
    studentLimit: 500,
    teacherLimit: 20
  },
  'future-sights': {
    id: 'future-sights',
    name: 'Future Sights Academy',
    domain: 'future.academy.tw',
    branding: {
      primaryColor: '#7C3AED',
      secondaryColor: '#10B981',
      logoUrl: 'https://cdn-icons-png.flaticon.com/512/2997/2997235.png',
      faviconUrl: 'https://cdn-icons-png.flaticon.com/512/2997/2997235.png',
    },
    studentLimit: 1200,
    teacherLimit: 80
  },
  'wise-wolf-school': {
    id: 'wise-wolf-school',
    name: 'Wise Wolf School',
    domain: 'escola.wisewolf.io',
    branding: {
      primaryColor: '#0f172a',
      secondaryColor: '#f59e0b',
      logoUrl: 'https://ui-avatars.com/api/?name=WW+School&background=0f172a&color=fff',
      faviconUrl: '',
    },
    studentLimit: 1000,
    teacherLimit: 50
  },
  'master': {
    id: 'master',
    name: 'Wise Wolf Platform (SaaS)',
    domain: 'wisewolf.io',
    branding: {
      primaryColor: '#002366',
      secondaryColor: '#D32F2F',
      logoUrl: 'https://ui-avatars.com/api/?name=Wise+Wolf',
      faviconUrl: '',
    },
    studentLimit: 999999,
    teacherLimit: 999999
  }
};

export const MOCK_ACCOUNTS = [
  {
    email: 'diretor@wisewolf.com',
    password: '123456',
    user: {
      id: 'ww-admin',
      tenantId: 'wise-wolf-school',
      name: 'Diretor Wise Wolf',
      email: 'diretor@wisewolf.com',
      role: UserRole.SCHOOL_ADMIN,
      avatar: 'https://i.pravatar.cc/150?u=wwadmin'
    }
  },
  {
    email: 'aluno@wisewolf.com',
    password: '123456',
    user: {
      id: 'ww-student',
      tenantId: 'wise-wolf-school',
      name: 'Aluno Teste WW',
      email: 'aluno@wisewolf.com',
      role: UserRole.STUDENT,
      avatar: 'https://i.pravatar.cc/150?u=wwstudent'
    }
  },
  {
    email: 'professor@wisewolf.com',
    password: '123456',
    user: {
      id: 'ww-prof',
      tenantId: 'wise-wolf-school',
      name: 'Prof. Lobo',
      email: 'professor@wisewolf.com',
      role: UserRole.TEACHER,
      avatar: 'https://i.pravatar.cc/150?u=wwprof'
    }
  },
  {
    email: 'diretor@royal.com',
    password: '123456',
    user: {
      id: 'admin-1',
      tenantId: 'royal-british',
      name: 'Diretoria Royal',
      email: 'diretor@royal.com',
      role: UserRole.SCHOOL_ADMIN,
      avatar: 'https://i.pravatar.cc/150?u=admin1'
    }
  },
  {
    email: 'professor@royal.com',
    password: '123456',
    user: {
      id: 'prof-1',
      tenantId: 'royal-british',
      name: 'Ricardo Silva (Teacher)',
      email: 'professor@royal.com',
      role: UserRole.TEACHER,
      avatar: 'https://i.pravatar.cc/150?u=prof1'
    }
  },
  {
    email: 'admin@educore.io',
    password: '123456',
    user: {
      id: 'super-1',
      tenantId: 'master',
      name: 'Suporte EduCore',
      email: 'admin@educore.io',
      role: UserRole.SUPER_ADMIN,
      avatar: 'https://i.pravatar.cc/150?u=super'
    }
  }
];

export const MOCK_STUDENTS_LIST = [];

export const PEDAGOGICAL_BOOKS = {
  'A1': [
    { part: 1, url: 'https://wisewolflanguage.com.br/books/book-a1-part-1.pdf' },
    { part: 2, url: 'https://wisewolflanguage.com.br/books/book-a1-part-2.pdf' },
    { part: 3, url: 'https://wisewolflanguage.com.br/books/book-a1-part-3.pdf' },
    { part: 4, url: 'https://wisewolflanguage.com.br/books/book-a1-part-4.pdf' },
  ],
  'A2': [
    { part: 1, url: 'http://wisewolflanguage.com.br/books/book-a2-part-1.pdf' },
  ],
  'B1': [
    { part: 1, url: 'http://wisewolflanguage.com.br/books/book-b1-part-1.pdf' },
  ]
};

export const PEDAGOGICAL_EVALUATIONS: Record<string, { question: string; options: string[]; correct: number }[]> = {
  'A1-1': [
    { question: "How do you say 'Oi' in English?", options: ["Bye", "Hello", "Night", "Good"], correct: 1 },
    { question: "Complete: 'I ___ a student.'", options: ["is", "are", "am", "be"], correct: 2 },
    { question: "What is the number 7?", options: ["Six", "Seven", "Eight", "Five"], correct: 1 },
    { question: "What is the opposite of 'Big'?", options: ["Large", "Small", "Tall", "Short"], correct: 1 },
    { question: "How do you ask someone's name?", options: ["How are you?", "What is your name?", "Where are you?", "Who are you?"], correct: 1 },
    { question: "What color is the sky (usually)?", options: ["Green", "Red", "Blue", "Yellow"], correct: 2 },
    { question: "Complete: 'She ___ my sister.'", options: ["am", "are", "is", "be"], correct: 2 },
    { question: "Day of the week after Monday:", options: ["Sunday", "Wednesday", "Friday", "Tuesday"], correct: 3 },
    { question: "What time is it if it's 8:00 AM?", options: ["Eight o'clock in the morning", "Eight in the night", "Noon", "Midnight"], correct: 0 },
    { question: "How do you say 'Obrigado'?", options: ["Please", "Sorry", "Thank you", "Welcome"], correct: 2 }
  ],
  'A1-2': [
    { question: "Translate 'Família' to English:", options: ["Friends", "Family", "Parents", "Group"], correct: 1 },
    { question: "Which is a member of the family?", options: ["Car", "Uncle", "School", "Blue"], correct: 1 },
    { question: "How do you say 'Pai'?", options: ["Mother", "Sister", "Father", "Brother"], correct: 2 },
    { question: "Complete: 'This is ___ book' (Posse de 'Eu')", options: ["my", "your", "his", "her"], correct: 0 },
    { question: "Routine: 'I ___ up at 7 AM.'", options: ["sleep", "go", "wake", "eat"], correct: 2 },
    { question: "Which verb describes eating in the morning?", options: ["Dinner", "Lunch", "Breakfast", "Snack"], correct: 2 },
    { question: "Complete: 'He ___ to school every day.'", options: ["go", "goes", "going", "gone"], correct: 1 },
    { question: "Translate 'Cozinha':", options: ["Bedroom", "Kitchen", "Living room", "Garden"], correct: 1 },
    { question: "What is a 'Cousin'?", options: ["Irmão", "Primo", "Tio", "Avô"], correct: 1 },
    { question: "Opposite of 'Old'?", options: ["New", "Fast", "Rich", "Young"], correct: 3 }
  ],
  'A2-1': [
    { question: "Past of 'Go'?", options: ["Goes", "Went", "Gone", "Going"], correct: 1 },
    { question: "How do you say 'Viajou'?", options: ["Travel", "Traveled", "Traveling", "Travelled"], correct: 1 },
    { question: "Which describes a 'Trip'?", options: ["Viagem", "Trabalho", "Estudo", "Dormir"], correct: 0 },
    { question: "Complete: 'I ___ a movie yesterday.'", options: ["watch", "watching", "watched", "watches"], correct: 2 },
    { question: "Directions: 'Turn ___' (Vire à direita)", options: ["Left", "Right", "Straight", "Back"], correct: 1 },
    { question: "Where do you buy bread?", options: ["Pharmacy", "Bakery", "Gym", "Cinema"], correct: 1 },
    { question: "Complete: 'Did you ___ pizza?'", options: ["eat", "ate", "eats", "eating"], correct: 0 },
    { question: "Translate 'Aeroporto':", options: ["Station", "Beach", "Airport", "Hotel"], correct: 2 },
    { question: "Which is a transport?", options: ["Apple", "Book", "Train", "Pen"], correct: 2 },
    { question: "How do you say 'Semana passada'?", options: ["Next week", "Last week", "Every week", "Today"], correct: 1 }
  ],
  'A2-2': [
    { question: "Complete: 'I have ___ to London.'", options: ["go", "went", "been", "goes"], correct: 2 },
    { question: "What is the past of 'Eat'?", options: ["Eated", "Ate", "Eaten", "Eating"], correct: 1 },
    { question: "Which word is for a professional cook?", options: ["Chef", "Teacher", "Driver", "Doctor"], correct: 0 },
    { question: "Translate 'Coração':", options: ["Head", "Hand", "Heart", "Foot"], correct: 2 },
    { question: "Which modal shows obligation?", options: ["Can", "Might", "Must", "Should"], correct: 2 },
    { question: "Complete: 'You ___ smoke here' (Proibição)", options: ["can", "should", "mustn't", "need"], correct: 2 },
    { question: "How do you say 'Amanhã'?", options: ["Yesterday", "Today", "Tomorrow", "Morning"], correct: 2 },
    { question: "What is 'Weather'?", options: ["Tempo (clima)", "Tempo (relógio)", "Dinheiro", "Rua"], correct: 0 },
    { question: "Past of 'Write'?", options: ["Writed", "Writen", "Wrote", "Writing"], correct: 2 },
    { question: "Opposite of 'Expensive'?", options: ["Cheap", "Rich", "Fast", "Hard"], correct: 0 }
  ],
  'B1-1': [
    { question: "Which tense uses 'Have/Has + Past Participle'?", options: ["Present Simple", "Past Simple", "Present Perfect", "Future"], correct: 2 },
    { question: "Translate 'Desenvolvimento':", options: ["Design", "Development", "Department", "Delivery"], correct: 1 },
    { question: "Complete: 'If it rains, I ___ stay home.'", options: ["would", "will", "did", "am"], correct: 1 },
    { question: "What does 'Nevertheless' mean?", options: ["Portanto", "No entanto", "Além disso", "Porque"], correct: 1 },
    { question: "Which is a formal way to start an email?", options: ["Hey!", "Yo!", "Dear Mr. Smith,", "Sup?"], correct: 2 },
    { question: "Complete: 'This car ___ made in Japan.'", options: ["is", "are", "have", "were"], correct: 0 },
    { question: "What is 'Reliable'?", options: ["Rápido", "Carinhoso", "Confiável", "Engraçado"], correct: 2 },
    { question: "Passive Voice: 'The cake ___ eaten by Jim.'", options: ["was", "is", "were", "been"], correct: 0 },
    { question: "Translate 'Expectativa':", options: ["Experience", "Exception", "Expectation", "Expert"], correct: 2 },
    { question: "Which is a synonym for 'Huge'?", options: ["Tiny", "Gigantic", "Small", "Regular"], correct: 1 }
  ]
};
