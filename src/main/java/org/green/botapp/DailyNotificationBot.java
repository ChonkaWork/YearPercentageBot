package org.green.botapp;

import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import org.telegram.telegrambots.bots.TelegramLongPollingBot;
import org.telegram.telegrambots.meta.api.methods.send.SendMessage;
import org.telegram.telegrambots.meta.api.objects.Update;

import java.time.LocalDate;

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
        String text = update.getMessage().getText();
        if (text.contains("year") || text.contains("рік")) {
            LocalDate localDate = LocalDate.now();
            int dayOfYear = localDate.getDayOfYear();
            double percentage = ((double) 366 / dayOfYear); // assuming it's a leap year
            sendMessage.setText("Сьогодні " + localDate.getYear() + " рік. День " + dayOfYear +
                    " з 366, це означає, що вже виконано приблизно " + String.format("%.2f", percentage) + "%");
        } else {
            sendMessage.setText("Привіт, " + update.getMessage().getFrom().getFirstName() + "!");
        }
        execute(sendMessage);
    }

    @Override
    public String getBotUsername() {
        return botName;
    }

}
