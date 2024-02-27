package org.green.botapp;

import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import org.telegram.telegrambots.bots.TelegramLongPollingBot;
import org.telegram.telegrambots.meta.api.methods.send.SendMessage;
import org.telegram.telegrambots.meta.api.objects.Update;

@Slf4j
public class DailyNotificationBot extends TelegramLongPollingBot {

    private final String botName;

    public DailyNotificationBot(String botToken, String botName) {
        super(botToken);
        this.botName = botName;
    }

    @Override
    @SneakyThrows
    public void onUpdateReceived(Update update) {
        log.info(update.toString());
        SendMessage sendMessage = new SendMessage();
        sendMessage.setChatId(update.getMessage().getChatId());
        sendMessage.setText("Hi!" + update);
        execute(sendMessage);
    }

    @Override
    public String getBotUsername() {
        return botName;
    }

}
