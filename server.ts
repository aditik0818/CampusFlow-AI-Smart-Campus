import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const app = express();
const PORT = 3000;

// Support larger payloads for image base64 uploads
app.use(express.json({ limit: '15mb' }));

// Helper to get GoogleGenAI client
function getAIClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// -------------------------------------------------------------
// Fallback Heuristics for offline / unkeyed demo resilience
// -------------------------------------------------------------
function heuristicAnalyze(title: string, description: string, location: string, existingIssues: any[] = []) {
  const text = `${title} ${description} ${location}`.toLowerCase();

  let category = 'Other';
  let department = 'Campus Facilities & Operations';
  let priority = 'Medium';

  if (text.includes('wifi') || text.includes('wi-fi') || text.includes('internet') || text.includes('network') || text.includes('dns') || text.includes('router') || text.includes('ethernet')) {
    category = 'Internet/Wi-Fi';
    department = 'IT Infrastructure & Networking';
    priority = text.includes('lab') || text.includes('exam') ? 'High' : 'Medium';
  } else if (text.includes('leak') || text.includes('water') || text.includes('pipe') || text.includes('flood') || text.includes('tap') || text.includes('drain')) {
    category = 'Water';
    department = 'Campus Plumbing & Civil Maintenance';
    priority = text.includes('flood') || text.includes('heavy') || text.includes('ceiling') ? 'Critical' : 'High';
  } else if (text.includes('projector') || text.includes('screen') || text.includes('mic') || text.includes('speaker') || text.includes('audio') || text.includes('display')) {
    category = 'Infrastructure';
    department = 'Campus AV & Classroom Tech Support';
    priority = 'High';
  } else if (text.includes('trash') || text.includes('garbage') || text.includes('clean') || text.includes('smell') || text.includes('waste') || text.includes('dust') || text.includes('overflow')) {
    category = 'Cleanliness';
    department = 'Housekeeping & Campus Sanitation';
    priority = text.includes('patio') || text.includes('cafeteria') ? 'Medium' : 'Low';
  } else if (text.includes('light') || text.includes('power') || text.includes('socket') || text.includes('spark') || text.includes('switch') || text.includes('electric')) {
    category = 'Electrical';
    department = 'Electrical & Grounds Infrastructure';
    priority = text.includes('spark') || text.includes('dark') ? 'High' : 'Medium';
  } else if (text.includes('hostel') || text.includes('dorm') || text.includes('room') || text.includes('elevator') || text.includes('warden')) {
    category = 'Hostel';
    department = 'Hostel Administration & Facilities';
    priority = text.includes('elevator') || text.includes('lock') ? 'Critical' : 'Medium';
  } else if (text.includes('bus') || text.includes('shuttle') || text.includes('parking') || text.includes('car') || text.includes('bike') || text.includes('transport')) {
    category = 'Transport';
    department = 'Campus Transport Services';
    priority = 'Low';
  } else if (text.includes('id card') || text.includes('wallet') || text.includes('lost') || text.includes('found') || text.includes('badge') || text.includes('keys')) {
    category = 'Lost & Found';
    department = 'Campus Security & Lost/Found Desk';
    priority = text.includes('id') ? 'High' : 'Medium';
  } else if (text.includes('theft') || text.includes('guard') || text.includes('security') || text.includes('gate') || text.includes('threat')) {
    category = 'Security';
    department = 'Campus Security Services';
    priority = 'High';
  }

  // Duplicate heuristic check
  let potentialDuplicate = null;
  const keywords = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  for (const existing of existingIssues) {
    if (existing.status === 'Resolved') continue;
    const existingText = `${existing.title} ${existing.description} ${existing.location}`.toLowerCase();
    let matches = 0;
    for (const kw of keywords) {
      if (existingText.includes(kw)) matches++;
    }
    const sameLoc = location && existing.location && (existing.location.toLowerCase().includes(location.toLowerCase()) || location.toLowerCase().includes(existing.location.toLowerCase()));
    
    if (matches >= 2 || (matches >= 1 && sameLoc)) {
      potentialDuplicate = {
        isDuplicate: true,
        similarityScore: sameLoc ? 88 : 74,
        existingIssueId: existing.id,
        existingIssueTitle: existing.title,
        reason: `Similar issue already active in ${existing.location}: "${existing.title}".`,
      };
      break;
    }
  }

  return {
    category,
    priority,
    summary: `${category} issue at ${location || 'campus'}: ${title}. Requires operational review by ${department}.`,
    department,
    potentialDuplicate,
  };
}

// -------------------------------------------------------------
// API Routes
// -------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', serverTime: new Date().toISOString() });
});

// Issue Analysis with Gemini
app.post('/api/ai/analyze-issue', async (req, res) => {
  const { title = '', description = '', location = '', imageBase64, imageMimeType = 'image/jpeg', existingIssues = [] } = req.body;

  if (!title.trim() && !description.trim()) {
    return res.status(400).json({ error: 'Please provide an issue title or description for analysis.' });
  }

  const ai = getAIClient();

  if (!ai) {
    // Return high quality heuristic analysis if API key is not yet set
    const fallback = heuristicAnalyze(title, description, location, existingIssues);
    return res.json({
      ...fallback,
      isAIModelUsed: false,
      note: 'Analyzed via rule engine. Provide GEMINI_API_KEY in Secrets for neural model inference.',
    });
  }

  try {
    const existingContext = existingIssues.slice(0, 10).map((issue: any) => ({
      id: issue.id,
      title: issue.title,
      location: issue.location,
      status: issue.status,
      category: issue.category,
    }));

    const promptText = `You are CampusFlow's AI Smart Campus Dispatch System.
Analyze this student campus issue report and classify it into structured actionable information.

Student Issue Report:
- Title: ${title}
- Description: ${description}
- Campus Location: ${location || 'Not specified'}

Active Open Campus Issues (for duplicate detection):
${JSON.stringify(existingContext, null, 2)}

Requirements:
1. Category: Must be exactly one of: ['Infrastructure', 'Internet/Wi-Fi', 'Cleanliness', 'Water', 'Electrical', 'Hostel', 'Transport', 'Security', 'Lost & Found', 'Other'].
2. Priority: Must be exactly one of: ['Low', 'Medium', 'High', 'Critical']. High/Critical should be assigned to safety hazards, flood/leakage, major exam/academic blocks disruptions, or security issues.
3. Summary: Generate a crisp 1-2 sentence professional executive summary for the campus administrator describing the root problem and its impact.
4. Department: Suggest the exact university department (e.g. 'Campus AV & Classroom Tech Support', 'IT Infrastructure & Networking', 'Plumbing & Civil Maintenance', 'Housekeeping & Sanitation', 'Electrical & Grounds Infrastructure', 'Hostel Administration', 'Campus Transport Services', 'Campus Security & Lost/Found Desk').
5. Potential Duplicate: Determine if this report duplicates or is directly related to any existing active issue in the list. If so, return isDuplicate: true, similarityScore (0-100), existingIssueId, existingIssueTitle, and an explanatory reason. Otherwise return null or isDuplicate: false.

Return valid JSON adhering to the schema.`;

    const contents: any = [];

    // If image provided, include it in multimodal prompt
    if (imageBase64) {
      const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
      contents.push({
        inlineData: {
          mimeType: imageMimeType || 'image/jpeg',
          data: cleanBase64,
        },
      });
    }

    contents.push({ text: promptText });

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: { parts: contents },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            category: {
              type: Type.STRING,
              description: 'The classified issue category',
            },
            priority: {
              type: Type.STRING,
              description: 'Low, Medium, High, or Critical',
            },
            summary: {
              type: Type.STRING,
              description: 'Professional executive summary for campus staff',
            },
            department: {
              type: Type.STRING,
              description: 'Recommended campus department to resolve this',
            },
            potentialDuplicate: {
              type: Type.OBJECT,
              properties: {
                isDuplicate: { type: Type.BOOLEAN },
                similarityScore: { type: Type.NUMBER },
                existingIssueId: { type: Type.STRING },
                existingIssueTitle: { type: Type.STRING },
                reason: { type: Type.STRING },
              },
            },
          },
          required: ['category', 'priority', 'summary', 'department'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    return res.json({
      category: parsed.category || 'Other',
      priority: parsed.priority || 'Medium',
      summary: parsed.summary || `${title} at ${location}`,
      department: parsed.department || 'Campus Facilities & Operations',
      potentialDuplicate: parsed.potentialDuplicate?.isDuplicate ? parsed.potentialDuplicate : null,
      isAIModelUsed: true,
    });
  } catch (error: any) {
    console.error('Gemini analyze-issue error:', error);
    // Fallback gracefully on any API issue
    const fallback = heuristicAnalyze(title, description, location, existingIssues);
    return res.json({
      ...fallback,
      isAIModelUsed: false,
      fallbackReason: error.message || 'AI service unavailable, used campus rule engine.',
    });
  }
});

// Lost & Found AI Matching
app.post('/api/ai/match-lost-found', async (req, res) => {
  const { lostItems = [], foundItems = [] } = req.body;

  const ai = getAIClient();

  if (!ai) {
    // Quick heuristic matcher
    const matches: any[] = [];
    for (const lost of lostItems) {
      if (lost.status === 'claimed') continue;
      for (const found of foundItems) {
        if (found.status === 'claimed') continue;
        const lostWords = `${lost.title} ${lost.description}`.toLowerCase().split(/\s+/);
        const foundWords = `${found.title} ${found.description}`.toLowerCase().split(/\s+/);
        const common = lostWords.filter((w: string) => w.length > 3 && foundWords.includes(w));
        const sameLoc = lost.location.toLowerCase() === found.location.toLowerCase();

        if (common.length >= 2 || (common.length >= 1 && sameLoc)) {
          matches.push({
            lostId: lost.id,
            foundId: found.id,
            matchScore: sameLoc ? 92 : 78,
            matchReason: `Matching item characteristics (${common.slice(0, 3).join(', ')}) in ${found.location}.`,
          });
        }
      }
    }
    return res.json({ matches, isAIModelUsed: false });
  }

  try {
    const prompt = `You are CampusFlow's AI Lost & Found Matching Engine.
Compare these lost items with found items on a university campus and identify potential matches.

Lost Items:
${JSON.stringify(lostItems, null, 2)}

Found Items:
${JSON.stringify(foundItems, null, 2)}

Identify any pairs that appear to refer to the exact same physical object based on:
1. Object type, brand, color, distinguishing stickers or tags
2. Proximity of reported location (e.g., Central Library 2nd floor vs Library study tables)
3. Dates reported

Return a list of matches with similarity score (50-100) and an explanation.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              lostId: { type: Type.STRING },
              foundId: { type: Type.STRING },
              matchScore: { type: Type.NUMBER },
              matchReason: { type: Type.STRING },
            },
            required: ['lostId', 'foundId', 'matchScore', 'matchReason'],
          },
        },
      },
    });

    const matches = JSON.parse(response.text || '[]');
    return res.json({ matches, isAIModelUsed: true });
  } catch (error: any) {
    console.error('Gemini match-lost-found error:', error);
    return res.json({ matches: [], error: error.message });
  }
});

// CampusFlow AI Assistant Chat
app.post('/api/ai/assistant', async (req, res) => {
  const { message = '', context = {} } = req.body;

  if (!message.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }

  const {
    openIssuesCount = 0,
    resolvedCount = 0,
    criticalIssues = [],
    pendingUserIssues = [],
    announcements = [],
  } = context;

  const ai = getAIClient();

  if (!ai) {
    // Intelligent fallback responses for sample questions
    const q = message.toLowerCase();
    let reply = '';

    if (q.includes('wifi') || q.includes('wi-fi') || q.includes('internet')) {
      reply = `To report a Wi-Fi or connectivity problem:\n1. Click **"Report Issue"** in the sidebar.\n2. Select **"Internet/Wi-Fi"** as the category and choose your campus location (e.g. Computer Lab or Library).\n3. Provide terminal/room details and click **"Analyze with AI"** to route directly to IT Infrastructure & Networking.\n\n*Campus Tip: You can also connect to the fallback SSID "CampusGuest-2G" during active maintenance.*`;
    } else if (q.includes('projector') || q.includes('classroom') || q.includes('broken')) {
      reply = `To report a broken projector or classroom AV equipment:\n1. Go to **"Report Issue"**.\n2. Specify the Academic Block and Hall/Room number (e.g. Room 302).\n3. Include a photo of the error light if possible. Campus AV Technicians will be dispatched immediately. Currently, work order #AV-492 is active for Room 302.`;
    } else if (q.includes('pending') || q.includes('my complaints') || q.includes('my status')) {
      reply = `You currently have **${pendingUserIssues.length || 1} active complaints** in the system.\n\nLatest: **"Broken projector in Academic Block Room 302"** is currently **In Progress** (Technician assigned: Marcus Vance). Total campus-wide open issues: ${openIssuesCount}.`;
    } else if (q.includes('id card') || q.includes('lost') || q.includes('found')) {
      reply = `If you lose your Student ID card:\n1. Check the **"Lost & Found"** section on CampusFlow — an automated AI match search will run immediately.\n2. Submit a report under **"Report Lost Item"** with your ID details.\n3. Visit the **Campus Security Desk at Main Gate / Admin Building** for temporary door access badges.\n\n*Note: Lost card reports are marked High priority automatically to prevent unauthorized facility access.*`;
    } else if (q.includes('unresolved') || q.includes('open complaints') || q.includes('critical')) {
      const critTitles = criticalIssues.map((c: any) => `• [${c.priority}] ${c.title} (${c.location})`).join('\n');
      reply = `Currently, there are **${openIssuesCount} unresolved complaints** across campus, including ${criticalIssues.length} critical issues:\n\n${critTitles || '• Water leakage near Hostel Complex (Under inspection)'}\n\nOur administrative departments review and prioritize tickets around the clock.`;
    } else {
      reply = `Hello! I am **CampusFlow AI**, your smart college campus assistant.\n\nI can help you:\n• Report facility, electrical, Wi-Fi, or water issues\n• Track real-time progress on your submitted complaints\n• Search and match items in the campus Lost & Found\n• Find department contacts and campus announcements.\n\nHow may I assist your campus life today?`;
    }

    return res.json({
      reply,
      isAIModelUsed: false,
    });
  }

  try {
    const systemPrompt = `You are CampusFlow AI, the university's official smart campus virtual assistant.
You are embedded in the CampusFlow web application used by students and campus administrators.

Live Campus Context:
- Active Unresolved Complaints: ${openIssuesCount}
- Resolved Complaints: ${resolvedCount}
- Critical Priority Issues: ${JSON.stringify(criticalIssues)}
- Student's Open Complaints: ${JSON.stringify(pendingUserIssues)}
- Recent Campus Announcements: ${JSON.stringify(announcements)}

Guidelines:
- Tone: Professional, student-friendly, reassuring, and concise.
- Provide actionable instructions (e.g. guide them to the "Report Issue" tab or "Lost & Found" section).
- When asked about their complaints, refer specifically to the provided student complaints.
- If asked about ID cards or lost items, explain the Lost & Found section and security desk protocols.
- Keep answers formatted with markdown bullet points for readability.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: message,
      config: {
        systemInstruction: systemPrompt,
      },
    });

    return res.json({
      reply: response.text || "I'm here to help with any campus complaints or questions.",
      isAIModelUsed: true,
    });
  } catch (error: any) {
    console.error('Gemini assistant error:', error);
    return res.json({
      reply: `CampusFlow AI is currently operating in offline campus mode. You can navigate using the sidebar to report issues or check the campus map. (${error.message})`,
      isAIModelUsed: false,
    });
  }
});

// -------------------------------------------------------------
// Vite Middleware / Static Server
// -------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CampusFlow server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
