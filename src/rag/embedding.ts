const OpenAI = require("openai");

const openai = new OpenAI({
    // 若没有配置环境变量，请用阿里云百炼API Key将下行替换为：apiKey:'sk-xxx',
    // 新加坡和北京地域的API Key不同。获取API Key：https://help.aliyun.com/zh/model-studio/get-api-key
    apiKey: process.env.DASHSCOPE_API_KEY,
    // 以下是北京地域base-url，如果使用新加坡地域的模型，需要将baseURL替换为：https://dashscope-intl.aliyuncs.com/compatible-mode/v1
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
});

async function getEmbedding() {
    try {
        const inputTexts = "衣服的质量杠杠的";
        const completion = await openai.embeddings.create({
            model: "text-embedding-v4",
            input: inputTexts
        });

        console.log(JSON.stringify(completion, null, 2));
    } catch (error) {
        console.error('Error:', error);
    }
}

getEmbedding();