/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_REQUEST_BYTES = 20_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const jsonResponse = (
  status: number,
  payload: Record<string, unknown>,
): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const mediaType = req.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  }

  const declaredLength = req.headers.get("content-length");
  if (declaredLength) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new HttpError(400, "INVALID_CONTENT_LENGTH");
    }
    if (Number.parseInt(declaredLength, 10) > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "REQUEST_TOO_LARGE");
    }
  }

  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "EMPTY_BODY");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "REQUEST_TOO_LARGE");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "JSON_OBJECT_REQUIRED");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_JSON");
  }
}

// --- DATA: PEDAGOGICAL EVALUATIONS (Server-Side Source of Truth) ---
// Copied from constants.tsx to ensure backend validation
const PEDAGOGICAL_EVALUATIONS: Record<
  string,
  { question: string; options: string[]; correct: number }[]
> = {
  "A1-1": [
    {
      question: "How do you say 'Oi' in English?",
      options: ["Bye", "Hello", "Night", "Good"],
      correct: 1,
    },
    {
      question: "Complete: 'I ___ a student.'",
      options: ["is", "are", "am", "be"],
      correct: 2,
    },
    {
      question: "What is the number 7?",
      options: ["Six", "Seven", "Eight", "Five"],
      correct: 1,
    },
    {
      question: "What is the opposite of 'Big'?",
      options: ["Large", "Small", "Tall", "Short"],
      correct: 1,
    },
    {
      question: "How do you ask someone's name?",
      options: [
        "How are you?",
        "What is your name?",
        "Where are you?",
        "Who are you?",
      ],
      correct: 1,
    },
    {
      question: "What color is the sky (usually)?",
      options: ["Green", "Red", "Blue", "Yellow"],
      correct: 2,
    },
    {
      question: "Complete: 'She ___ my sister.'",
      options: ["am", "are", "is", "be"],
      correct: 2,
    },
    {
      question: "Day of the week after Monday:",
      options: ["Sunday", "Wednesday", "Friday", "Tuesday"],
      correct: 3,
    },
    {
      question: "What time is it if it's 8:00 AM?",
      options: [
        "Eight o'clock in the morning",
        "Eight in the night",
        "Noon",
        "Midnight",
      ],
      correct: 0,
    },
    {
      question: "How do you say 'Obrigado'?",
      options: ["Please", "Sorry", "Thank you", "Welcome"],
      correct: 2,
    },
  ],
  "A1-2": [
    {
      question: "Translate 'Família' to English:",
      options: ["Friends", "Family", "Parents", "Group"],
      correct: 1,
    },
    {
      question: "Which is a member of the family?",
      options: ["Car", "Uncle", "School", "Blue"],
      correct: 1,
    },
    {
      question: "How do you say 'Pai'?",
      options: ["Mother", "Sister", "Father", "Brother"],
      correct: 2,
    },
    {
      question: "Complete: 'This is ___ book' (Posse de 'Eu')",
      options: ["my", "your", "his", "her"],
      correct: 0,
    },
    {
      question: "Routine: 'I ___ up at 7 AM.'",
      options: ["sleep", "go", "wake", "eat"],
      correct: 2,
    },
    {
      question: "Which verb describes eating in the morning?",
      options: ["Dinner", "Lunch", "Breakfast", "Snack"],
      correct: 2,
    },
    {
      question: "Complete: 'He ___ to school every day.'",
      options: ["go", "goes", "going", "gone"],
      correct: 1,
    },
    {
      question: "Translate 'Cozinha':",
      options: ["Bedroom", "Kitchen", "Living room", "Garden"],
      correct: 1,
    },
    {
      question: "What is a 'Cousin'?",
      options: ["Irmão", "Primo", "Tio", "Avô"],
      correct: 1,
    },
    {
      question: "Opposite of 'Old'?",
      options: ["New", "Fast", "Rich", "Young"],
      correct: 3,
    },
  ],
  "A2-1": [
    {
      question: "Past of 'Go'?",
      options: ["Goes", "Went", "Gone", "Going"],
      correct: 1,
    },
    {
      question: "How do you say 'Viajou'?",
      options: ["Travel", "Traveled", "Traveling", "Travelled"],
      correct: 1,
    },
    {
      question: "Which describes a 'Trip'?",
      options: ["Viagem", "Trabalho", "Estudo", "Dormir"],
      correct: 0,
    },
    {
      question: "Complete: 'I ___ a movie yesterday.'",
      options: ["watch", "watching", "watched", "watches"],
      correct: 2,
    },
    {
      question: "Directions: 'Turn ___' (Vire à direita)",
      options: ["Left", "Right", "Straight", "Back"],
      correct: 1,
    },
    {
      question: "Where do you buy bread?",
      options: ["Pharmacy", "Bakery", "Gym", "Cinema"],
      correct: 1,
    },
    {
      question: "Complete: 'Did you ___ pizza?'",
      options: ["eat", "ate", "eats", "eating"],
      correct: 0,
    },
    {
      question: "Translate 'Aeroporto':",
      options: ["Station", "Beach", "Airport", "Hotel"],
      correct: 2,
    },
    {
      question: "Which is a transport?",
      options: ["Apple", "Book", "Train", "Pen"],
      correct: 2,
    },
    {
      question: "How do you say 'Semana passada'?",
      options: ["Next week", "Last week", "Every week", "Today"],
      correct: 1,
    },
  ],
  "A2-2": [
    {
      question: "Complete: 'I have ___ to London.'",
      options: ["go", "went", "been", "goes"],
      correct: 2,
    },
    {
      question: "What is the past of 'Eat'?",
      options: ["Eated", "Ate", "Eaten", "Eating"],
      correct: 1,
    },
    {
      question: "Which word is for a professional cook?",
      options: ["Chef", "Teacher", "Driver", "Doctor"],
      correct: 0,
    },
    {
      question: "Translate 'Coração':",
      options: ["Head", "Hand", "Heart", "Foot"],
      correct: 2,
    },
    {
      question: "Which modal shows obligation?",
      options: ["Can", "Might", "Must", "Should"],
      correct: 2,
    },
    {
      question: "Complete: 'You ___ smoke here' (Proibição)",
      options: ["can", "should", "mustn't", "need"],
      correct: 2,
    },
    {
      question: "How do you say 'Amanhã'?",
      options: ["Yesterday", "Today", "Tomorrow", "Morning"],
      correct: 2,
    },
    {
      question: "What is 'Weather'?",
      options: ["Tempo (clima)", "Tempo (relógio)", "Dinheiro", "Rua"],
      correct: 0,
    },
    {
      question: "Past of 'Write'?",
      options: ["Writed", "Writen", "Wrote", "Writing"],
      correct: 2,
    },
    {
      question: "Opposite of 'Expensive'?",
      options: ["Cheap", "Rich", "Fast", "Hard"],
      correct: 0,
    },
  ],
  "B1-1": [
    {
      question: "Which tense uses 'Have/Has + Past Participle'?",
      options: ["Present Simple", "Past Simple", "Present Perfect", "Future"],
      correct: 2,
    },
    {
      question: "Translate 'Desenvolvimento':",
      options: ["Design", "Development", "Department", "Delivery"],
      correct: 1,
    },
    {
      question: "Complete: 'If it rains, I ___ stay home.'",
      options: ["would", "will", "did", "am"],
      correct: 1,
    },
    {
      question: "What does 'Nevertheless' mean?",
      options: ["Portanto", "No entanto", "Além disso", "Porque"],
      correct: 1,
    },
    {
      question: "Which is a formal way to start an email?",
      options: ["Hey!", "Yo!", "Dear Mr. Smith,", "Sup?"],
      correct: 2,
    },
    {
      question: "Complete: 'This car ___ made in Japan.'",
      options: ["is", "are", "have", "were"],
      correct: 0,
    },
    {
      question: "What is 'Reliable'?",
      options: ["Rápido", "Carinhoso", "Confiável", "Engraçado"],
      correct: 2,
    },
    {
      question: "Passive Voice: 'The cake ___ eaten by Jim.'",
      options: ["was", "is", "were", "been"],
      correct: 0,
    },
    {
      question: "Translate 'Expectativa':",
      options: ["Experience", "Exception", "Expectation", "Expert"],
      correct: 2,
    },
    {
      question: "Which is a synonym for 'Huge'?",
      options: ["Tiny", "Gigantic", "Small", "Regular"],
      correct: 1,
    },
  ],
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  try {
    const auth = await authorizeRequest(req, {
      corsHeaders,
      allowedRoles: ["STUDENT"],
    });
    if (auth.ok === false) return auth.response;

    const body = await readJsonObject(req);
    const bookPart = typeof body.bookPart === "string"
      ? body.bookPart.trim()
      : "";
    const quiz = PEDAGOGICAL_EVALUATIONS[bookPart];
    if (!quiz) throw new HttpError(404, "QUIZ_NOT_FOUND");
    if (!Array.isArray(body.answers) || body.answers.length !== quiz.length) {
      throw new HttpError(400, "INVALID_ANSWERS");
    }

    const answers = body.answers.map((answer, index) => {
      const optionCount = quiz[index]?.options.length ?? 0;
      if (
        !Number.isInteger(answer) ||
        Number(answer) < 0 ||
        Number(answer) >= optionCount
      ) {
        throw new HttpError(400, "INVALID_ANSWERS");
      }
      return Number(answer);
    });
    const correctCount = quiz.reduce(
      (total, question, index) =>
        total + (answers[index] === question.correct ? 1 : 0),
      0,
    );

    const { data, error } = await auth.context.admin.rpc(
      "record_verified_pedagogical_quiz",
      {
        p_student_id: auth.context.userId,
        p_book_part: bookPart,
        p_score: correctCount,
        p_total_questions: quiz.length,
        p_answers: answers,
      },
    );
    if (error || !data || typeof data !== "object") {
      const message = String(error?.message ?? "").toLowerCase();
      if (message.includes("quiz_not_unlocked")) {
        throw new HttpError(409, "QUIZ_NOT_UNLOCKED");
      }
      if (message.includes("student_profile_required")) {
        throw new HttpError(403, "STUDENT_PROFILE_REQUIRED");
      }
      console.error("[submit-quiz] verified result persistence failed", {
        code: error?.code ?? "invalid_result",
      });
      throw new HttpError(503, "QUIZ_RESULT_SAVE_FAILED");
    }

    return jsonResponse(200, {
      success: true,
      ...(data as Record<string, unknown>),
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, {
        error: error.code,
        code: error.code,
      });
    }
    console.error("[submit-quiz] request failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return jsonResponse(500, {
      error: "QUIZ_SUBMISSION_FAILED",
      code: "QUIZ_SUBMISSION_FAILED",
    });
  }
});
