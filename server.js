const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
require('dotenv').config(); // 상단에 추가
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

// process.env.변수명 으로 키를 안전하게 불러옴
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

let db;

(async () => {
    db = await open({
        filename: '../ai_coding_db.sqlite', 
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS problems (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            difficulty TEXT NOT NULL,
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
    console.log("📂 SQLite 데이터베이스 준비 완료!");
})();

// [수정된 부분] 강력한 JSON 정제 로직 포함
app.post('/api/generate', async (req, res) => {
    try {
        const { difficulty } = req.body; 
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `알고리즘 문제 출제자입니다. 타겟 계층 [${difficulty}]에 맞는 문제를 생성하세요.
반드시 JSON 형식만 반환하세요.
{"title": "문제 제목", "desc": "문제 상세 설명(HTML 형식)"}`;
        
        const result = await model.generateContent(prompt);
        let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        // 💡 제어 문자 완벽 제거
        text = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""); 
        
        const problemData = JSON.parse(text);
        const dbResult = await db.run(
            'INSERT INTO problems (title, description, difficulty) VALUES (?, ?, ?)',
            [problemData.title, problemData.desc, difficulty]
        );
        res.json({ id: dbResult.lastID, ...problemData });
    } catch (error) { 
        console.error("JSON 파싱 에러:", error);
        res.status(500).json({ error: '문제 생성 실패' }); 
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { problemId, code, problemTitle, question } = req.body;
        await db.run('INSERT INTO chat_logs (problem_id, sender, message) VALUES (?, "user", ?)', [problemId, question]);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(`AI 멘토입니다. 정답 코드를 주지 말고 힌트만 주세요.\n문제: ${problemTitle}\n질문: ${question}`);
        const answer = result.response.text();
        await db.run('INSERT INTO chat_logs (problem_id, sender, message) VALUES (?, "bot", ?)', [problemId, answer]);
        res.json({ answer });
    } catch (error) { res.status(500).json({ error: '채팅 실패' }); }
});

app.post('/api/run', async (req, res) => {
    try {
        const { problemId, code, language, difficulty, problemTitle, problemDesc } = req.body;
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `알고리즘 채점관입니다. 코드 정답 여부를 판별해 순수 JSON만 반환하세요.\n문제: ${problemTitle}\n조건: ${problemDesc}\n코드:\n${code}\n형식: {"isCorrect": true/false, "message": "피드백", "score": 85}`;
        const result = await model.generateContent(prompt);
        let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        text = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
        const grading = JSON.parse(text);

        await db.run(
            'INSERT INTO submissions (problem_id, code, language, is_correct, feedback, score) VALUES (?, ?, ?, ?, ?, ?)',
            [problemId, code, language, grading.isCorrect ? 1 : 0, grading.message, grading.score || 0]
        );
        res.json(grading);
    } catch (error) { res.status(500).json({ error: '채점 실패' }); }
});

app.get('/api/history', async (req, res) => {
    const rows = await db.all(`SELECT s.id AS submission_id, p.id AS problem_id, p.title, p.difficulty, s.language, s.is_correct, s.score, s.created_at FROM submissions s JOIN problems p ON s.problem_id = p.id ORDER BY s.created_at DESC`);
    res.json(rows);
});

app.get('/api/history/:problemId', async (req, res) => {
    const problem = await db.get('SELECT * FROM problems WHERE id = ?', [req.params.problemId]);
    const codeBlock = await db.get('SELECT code, language FROM submissions WHERE problem_id = ? ORDER BY id DESC LIMIT 1', [req.params.problemId]);
    const chats = await db.all('SELECT sender, message FROM chat_logs WHERE problem_id = ? ORDER BY created_at ASC', [req.params.problemId]);
    res.json({ problem, lastCode: codeBlock?.code || '', lastLang: codeBlock?.language || 'JavaScript', chatHistory: chats });
});

app.delete('/api/history/:submissionId', async (req, res) => {
    await db.run('DELETE FROM submissions WHERE id = ?', [req.params.submissionId]);
    res.json({ success: true });
});

app.listen(5000, () => console.log(`🚀 서버 가동 중 (Port 5000)`));