require('dotenv').config();

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

// 환경 변수로 API 키 안전하게 로드
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

let db;

// DB 초기화 (새로운 컬럼이 적용된 v2 데이터베이스)
(async () => {
    db = await open({
        filename: '../ai_coding_db_v2.sqlite', 
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS problems (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            difficulty TEXT NOT NULL,
            company TEXT,
            category TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            problem_id INTEGER,
            code TEXT NOT NULL,
            language TEXT NOT NULL,
            is_correct INTEGER NOT NULL,
            feedback TEXT,
            score INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
        )
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS chat_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            problem_id INTEGER,
            sender TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
        )
    `);
    console.log("📂 SQLite 데이터베이스 및 3대 혁신 기능 테이블 준비 완료!");
})();

// [핵심 보완] 문제 생성 API (프롬프트 엄격 통제 적용)
app.post('/api/generate', async (req, res) => {
    try {
        const { difficulty, company, customPrompt, recommendCategory } = req.body; 
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        let targetInstruction = `타겟 계층 [${difficulty}]에 맞는 일반적인 알고리즘 문제를 생성하세요.`;
        
        if (company && company !== '일반') {
            targetInstruction = `[${company}] 기업의 실제 코딩 테스트 출제 경향과 빈출 유형을 분석하여 문항 간의 '상대적 난이도 [${difficulty}]'에 맞는 기출 변형 문제를 생성하세요.
            🚨 주의: 만약 기업이 '우아한형제들'이라면 절대 경쟁사나 다른 서비스 이름(예: 요기요 등)을 언급하지 말고 오직 '배달의민족(배민)' 서비스 상황으로만 한정하여 스토리를 짜세요.`;
        }

        if (customPrompt) {
            targetInstruction += `\n비즈니스 요구사항 추가: 유저가 요청한 특별 주제인 [${customPrompt}]에 관련된 상황이나 도메인을 무조건 반영하여 출제하세요.`;
        }

        if (recommendCategory) {
            targetInstruction += `\n유형 강제 지정: 다른 유형은 배제하고 반드시 [${recommendCategory}] 알고리즘 유형으로 문제를 생성하세요.`;
        }

        // 화면 레이아웃 붕괴 방지를 위한 HTML 태그 제한 프롬프트
        const prompt = `당신은 최고 수준의 알고리즘 출제 위원입니다. ${targetInstruction}
        반드시 순수한 JSON 형식만 반환하세요. 마크다운 기호는 절대 금지합니다.
        형식: {"title": "문제 제목", "desc": "문제 상세 설명(HTML 형식. 단, 화면 레이아웃을 깨는 div 태그는 절대 사용 금지. 오직 <p>, <br>, <b>, <strong>, <ul>, <li> 태그만 완벽하게 닫아서 사용할 것)", "category": "알고리즘 유형(예: 문자열 파싱, DFS/BFS, 구현, DP, 그리디 중 택1)"}`;
        
        const result = await model.generateContent(prompt);
        let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        text = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""); 
        
        const problemData = JSON.parse(text);
        
        const dbResult = await db.run(
            'INSERT INTO problems (title, description, difficulty, company, category) VALUES (?, ?, ?, ?, ?)',
            [problemData.title, problemData.desc, difficulty, company || '일반', problemData.category || '일반 구현']
        );
        res.json({ id: dbResult.lastID, company: company || '일반', ...problemData });
    } catch (error) { 
        console.error("JSON 파싱 에러:", error);
        res.status(500).json({ error: '문제 생성 실패' }); 
    }
});

// AI 코드 최적화(리팩토링) 및 복잡도 분석 API
app.post('/api/refactor', async (req, res) => {
    try {
        const { code, problemTitle } = req.body;
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const prompt = `당신은 소프트웨어 아키텍트이자 코드 최적화 전문가입니다. 
        다음 문제를 풀기 위해 작성된 코드를 분석하고, 시간/공간 복잡도가 최적화된 리팩토링 코드를 제안하세요.
        문제: ${problemTitle}
        작성된 코드:
        ${code}
        
        반드시 마크다운 없이 순수 JSON으로만 응답하세요.
        형식: {"refactoredCode": "개선된 전체 소스 코드", "analysis": "시간/공간 복잡도 변화 설명 및 개선점 요약", "originalCost": 100, "optimizedCost": 개선후의 상대적 자원 소모도(기존을 100으로 잡고 효율성에 따라 10~90 사이 숫자로 표현할 것)}"`;
        
        const result = await model.generateContent(prompt);
        let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        text = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""); 
        
        res.json(JSON.parse(text));
    } catch (error) {
        res.status(500).json({ error: '리팩토링 분석 실패' });
    }
});

// 취약점 진단 및 알고리즘 추천 API
app.get('/api/recommend', async (req, res) => {
    try {
        const history = await db.all(`
            SELECT p.category, s.is_correct 
            FROM submissions s 
            JOIN problems p ON s.problem_id = p.id
        `);
        
        if (history.length < 3) {
            return res.json({ status: 'NEED_DATA', message: '취약점 분석을 위해 문제를 최소 3회 이상 제출해 주세요!' });
        }
        
        const stats = {};
        history.forEach(row => {
            if (!stats[row.category]) stats[row.category] = { total: 0, correct: 0 };
            stats[row.category].total++;
            if (row.is_correct === 1) stats[row.category].correct++;
        });
        
        let weakestCategory = '';
        let lowestRate = 1.1; 
        
        for (const cat in stats) {
            const rate = stats[cat].correct / stats[cat].total;
            if (rate < lowestRate) {
                lowestRate = rate;
                weakestCategory = cat;
            }
        }
        
        res.json({
            status: 'SUCCESS',
            weakestCategory,
            message: `현재 유저님의 가장 취약한 알고리즘 유형은 **[${weakestCategory}]** (정답률: ${Math.round(lowestRate * 100)}%) 입니다. 이를 보완할 집중 훈련 챌린지를 추천합니다.`
        });
    } catch (error) {
        res.status(500).json({ error: '추천 데이터 로드 실패' });
    }
});

// 채팅 멘토 API
app.post('/api/chat', async (req, res) => {
    try {
        const { problemId, code, problemTitle, question } = req.body;
        await db.run('INSERT INTO chat_logs (problem_id, sender, message) VALUES (?, "user", ?)', [problemId, question]);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(`AI 멘토입니다. 정답 코드를 주지 말고 힌트만 주세요.\n문제: ${problemTitle}\n현재 코드:\n${code}\n질문: ${question}`);
        const answer = result.response.text();
        await db.run('INSERT INTO chat_logs (problem_id, sender, message) VALUES (?, "bot", ?)', [problemId, answer]);
        res.json({ answer });
    } catch (error) { res.status(500).json({ error: '채팅 실패' }); }
});

// [핵심 보완] 자동 채점 API (에러 방어 완벽 적용)
app.post('/api/run', async (req, res) => {
    try {
        const { problemId, code, language, difficulty, problemTitle, problemDesc } = req.body;
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const prompt = `당신은 너그럽고 정확한 알고리즘 채점관입니다.
        제출된 코드가 문제의 요구사항과 핵심 로직(수식 등)을 충족한다면 반드시 정답(true) 처리하세요.
        입출력 처리(예: readline 등)가 완벽하지 않더라도 함수 로직이 맞으면 정답으로 인정합니다.

        문제 제목: ${problemTitle}
        조건: ${problemDesc}
        코드:
        ${code}
        언어: ${language}
        
        🚨 주의: 반드시 아래의 순수 JSON 형식으로만 답변하세요. 마크다운은 금지하며, 키(key) 이름은 반드시 소문자/대문자를 지켜주세요.
        형식: {"isCorrect": true, "message": "정확한 계산 로직입니다! 수고하셨습니다.", "score": 100}`;
        
        const result = await model.generateContent(prompt);
        let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        text = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
        
        const grading = JSON.parse(text);

        let finalMessage = grading.message || grading.feedback || "채점이 완료되었습니다.";

        await db.run(
            'INSERT INTO submissions (problem_id, code, language, is_correct, feedback, score) VALUES (?, ?, ?, ?, ?, ?)',
            [problemId, code, language, grading.isCorrect ? 1 : 0, finalMessage, grading.score || 0]
        );
        
        res.json({
            isCorrect: grading.isCorrect,
            message: finalMessage,
            score: grading.score
        });
    } catch (error) { 
        console.error("채점 에러:", error);
        // 🚨 AI 서버 과부하(429 에러) 발생 시 오답 대신 정확한 안내 메시지 전송!
        res.json({
            isCorrect: false,
            message: "⚠️ 구글 AI 서버 트래픽이 초과되었습니다. (무료 할당량 초과)\n잠시 1분만 기다리셨다가 다시 채점 버튼을 눌러주세요!",
            score: 0
        });
    }
});

// 히스토리 목록 조회 API
app.get('/api/history', async (req, res) => {
    const rows = await db.all(`SELECT s.id AS submission_id, p.id AS problem_id, p.title, p.difficulty, p.company, s.language, s.is_correct, s.score, s.created_at FROM submissions s JOIN problems p ON s.problem_id = p.id ORDER BY s.created_at DESC`);
    res.json(rows);
});

// 특정 히스토리 상세 조회 API
app.get('/api/history/:problemId', async (req, res) => {
    const problem = await db.get('SELECT * FROM problems WHERE id = ?', [req.params.problemId]);
    const codeBlock = await db.get('SELECT code, language FROM submissions WHERE problem_id = ? ORDER BY id DESC LIMIT 1', [req.params.problemId]);
    const chats = await db.all('SELECT sender, message FROM chat_logs WHERE problem_id = ? ORDER BY created_at ASC', [req.params.problemId]);
    res.json({ problem, lastCode: codeBlock?.code || '', lastLang: codeBlock?.language || 'JavaScript', chatHistory: chats });
});

// 히스토리 삭제 API
app.delete('/api/history/:submissionId', async (req, res) => {
    await db.run('DELETE FROM submissions WHERE id = ?', [req.params.submissionId]);
    res.json({ success: true });
});

app.listen(5000, () => console.log(`🚀 서버 가동 중 (Port 5000)`));