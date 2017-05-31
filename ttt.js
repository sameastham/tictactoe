$(document).ready(function() {
    //empty array to store squares in
    squareArray = [0,0,0,0,0,0,0,0,0];
    
    //counters for player scores
    p1count = 0;
    p2count = 0;
    
    //stores div with specified ID with corresponding location in array
    var squareArrayStore = function(divID) {
        if (document.getElementById(divID).className === 'x') {
            return 1;
        }
        else if (document.getElementById(divID).className === 'o') {
            return 2;
        }
        else {
            return 0;
        }
    };
    
    //clears the board
    var clearboard = function() {
        $('div.x').addClass('button');
        $('div.o').addClass('button');
        $('div.x').removeClass('x');
        $('div.o').removeClass('o');
        squareArray = [0,0,0,0,0,0,0,0,0];
    }
    
    //checks if three squares are equal, gives alert if player has won
    var squareEqualCheck = function(num1,num2,num3,playerNum) {
        if (squareArray[num1] === squareArray[num2] && squareArray[num2] === squareArray[num3] && squareArray[num1] === playerNum) {
            $('#' + parseInt(num1)).toggleClass('threeinarow');
            $('#' + parseInt(num2)).toggleClass('threeinarow');
            $('#' + parseInt(num3)).toggleClass('threeinarow');
            alert("Player " + playerNum + " Wins!");
            if (playerNum === 1) {
                p1count++;
            }
            else if (playerNum === 2) {
                p2count++;
            }
            $('#p1score').text(p1count);
            $('#p2score').text(p2count);
            $('#' + parseInt(num1)).toggleClass('threeinarow');
            $('#' + parseInt(num2)).toggleClass('threeinarow');
            $('#' + parseInt(num3)).toggleClass('threeinarow');
            clearboard();
        }
    };
    
    //checks if a player has won the game
    var playerWonCheck = function(player) {
        squareEqualCheck(0,1,2,player);
        squareEqualCheck(3,4,5,player);
        squareEqualCheck(6,7,8,player);
        squareEqualCheck(0,3,6,player);
        squareEqualCheck(1,4,7,player);
        squareEqualCheck(2,5,8,player);
        squareEqualCheck(0,4,8,player);
        squareEqualCheck(2,4,6,player);
    };
    //buttons for the game
    $('div.button').click(function() {
        if($(this).hasClass('button')) {
            if (($('.x').length + $('.o').length) === 8) {
                $(this).toggleClass("x");
                $(this).removeClass('button');
                squareArray[$(this).attr('id')] = squareArrayStore($(this).attr('id'));
                playerWonCheck(1);
                playerWonCheck(2);
                alert('Tie game!');
                clearboard();
                return;
            }
            else if (($('.x').length + $('.o').length) % 2 === 0) {
                $(this).toggleClass("x");
                $(this).removeClass('button');
            }
            else {
                $(this).toggleClass("o");
                $(this).removeClass('button');
            }
            squareArray[$(this).attr('id')] = squareArrayStore($(this).attr('id'));
            playerWonCheck(1);
            playerWonCheck(2);
        }
    });
    
    $('#clearBoard').click(function() {
        clearboard();
    });
    
    $('#resetScores').click(function() {
        p1count = 0;
        p2count = 0;
        $('#p1score').text(p1count);
        $('#p2score').text(p2count);
    });
});