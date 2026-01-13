# NOTE
While you are free to use this extension however you see fit, I made this for personal use so it may be buggy or not work for you. At the moment it's not something I plan to release officially, but if you do use it and find issues you can reach out to me. Otherwise, feel free to clone and modify it as needed for you but don't forget the plugin as well. 

Just so you don't expect crazy code quality, it was 100% vibe coded using kiro and claude opus. I know I don't use getContext as well, I learned of that after most of the code was written. And didn't feel like refactoring it all.

> Currently DOES NOT support group chats

## Chat Branches

Injects uuids into chat metadata to form branch trees for current chat. Builds tree based on parent child relationships. You can right click nodes to view messages and click them to jump to that chat/message you can also edit chat names by clicking the pencil icon next to the chat name.

## Requirements

You need the server plugin for it to work, Why? because I have to manipulate the file system to make smarter storage. Blame SillyTavern for their dookie filename chat saving system
[Server plugin](https://github.com/spaceman2408/chat-branches-plugin)

install:
extensions -> install extension -> https://github.com/spaceman2408/SillyTavern-ChatBranches

# What it looks like
![](https://i.imgur.com/59Sqy7G.png)

![](https://i.imgur.com/r4HY3G9.png)