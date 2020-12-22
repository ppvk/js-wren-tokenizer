const path = require('path');
const ESLintPlugin = require('eslint-webpack-plugin');

module.exports = {
    mode: 'development',
    entry: './src/main.js',
    performance: {
        hints: false
    },
    output: {
        path: path.resolve(__dirname, '../out'),
        filename: 'wrent.js',
        library: 'Wrent'
    },
    module: {
        rules: [
            {
                test: /\.ne$/,
                use: [
                    'nearley-loader',
                ],
            },
        ]
    },
    plugins: [new ESLintPlugin({
        'fix': true,
        'overrideConfig': {
            'env': {
                'browser': true,
                'es2021': true,
                'node': true
            },
            'extends': 'eslint:recommended',
            'parserOptions': {
                'ecmaVersion': 12,
                'sourceType': 'module'
            },
            'rules': {
                'indent': [
                    'error',
                    4
                ],
                'linebreak-style': [
                    'error',
                    'unix'
                ],
                'quotes': [
                    'error',
                    'single'
                ],
                'semi': [
                    'error',
                    'always'
                ]
            }
        }
    })],
    watch: true
};
